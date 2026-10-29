/**
 * Escape IR exporter (P4 + closures) — lowers a TypeScript program to the
 * Escape IR JSON consumed by the Rust analyzer, using the classic `tsc` API.
 *
 * Closure conversion:
 *  - Free-variable analysis (transitive) finds which bindings are captured by
 *    a nested function. Captured bindings become single-slot "cells" (an object
 *    with a reserved `value` field); non-captured locals stay plain stack locals.
 *  - Reads/writes of a captured binding become LoadField/StoreField on its cell.
 *  - A function expression / arrow is lambda-lifted to its own IR function whose
 *    LEADING parameters are exactly the captured cells (in capture order). At the
 *    creation site we emit AllocClosure wiring the closure object to those cells.
 *  - Cells owned by a function are pre-allocated in its prologue so capture wiring
 *    is order-independent; cells captured from an outer scope are threaded in as
 *    the lifted function's cell-parameters.
 *
 * Usage: node exporter.js <input.ts> <program.json> <labels.json>
 */
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import { ClassExtractor, ClassInfo, ClosedReceivers, memberKeyName, dynamicBaseEmptyClass } from "./class_extract";
import { JSX_ENTITIES } from "./jsx_entities";
/** A regexp literal's text split into its source and flags (`/src/flags`). */
function splitRegExpLiteral(raw: string): { source: string; flags: string } | undefined {
  if (raw.length < 2 || raw[0] !== "/") return undefined;
  const slash = raw.lastIndexOf("/");
  if (slash <= 0) return undefined;
  return { source: raw.slice(1, slash), flags: raw.slice(slash + 1) };
}
import { hasUnpairedSurrogate, toWireProgram } from "./wire_program";

type RefKind = "reference" | "primitive" | "unknown";
type SourceMode = "module" | "script";
type StrictTypeOptionName =
  | "noImplicitAny"
  | "strictNullChecks"
  | "strictFunctionTypes"
  | "strictBindCallApply"
  | "strictPropertyInitialization"
  | "noImplicitThis"
  | "useUnknownInCatchVariables"
  | "alwaysStrict";
type StrictTypeOptimizationProfile = {
  enabled: boolean;
  strictProfile: boolean;
  diagnosticClean: boolean;
  diagnosticCount: number;
  reason: "enabled" | "strictProfileIncomplete" | "typeDiagnostics" | "untyped";
  options: Record<StrictTypeOptionName, boolean>;
};
type TypeSpec =
  | { kind: "number"; key: "number"; refKind: "primitive" }
  | { kind: "string"; key: "string"; refKind: "reference" }
  | { kind: "undefined"; key: "undefined"; refKind: "primitive" }
  | { kind: "null"; key: "null"; refKind: "primitive" }
  | { kind: "array"; key: string; refKind: "reference"; elem: TypeSpec }
  | { kind: "erased"; key: string; refKind: RefKind };
type GenericInferencePattern =
  | { kind: "direct"; tpName: string }
  | { kind: "arrayElement"; tpName: string };
/** A producer of objects of `type`: a constructor function's prefix layout or a
 *  fresh-object store sequence; `keys` in slot order (docs/static_slots_design.md). */
type ProducerLayout = { name: string; type: ts.Type | undefined; keys: string[]; ctor?: ts.Symbol };

/** Typed array constructors and their runtime element types (TS_TA_* in
 *  runtime/ts_rt.h; docs/typed_arrays_design.md). */
const TYPED_ARRAY_ELEMS: ReadonlyMap<string, number> = new Map([
  ["Int8Array", 0], ["Uint8Array", 1], ["Uint8ClampedArray", 2], ["Int16Array", 3], ["Uint16Array", 4],
  ["Int32Array", 5], ["Uint32Array", 6], ["Float32Array", 7], ["Float64Array", 8],
]);
const TYPED_ARRAY_BYTES = [1, 1, 1, 2, 2, 4, 4, 4, 8];
/** NodeFlags.Ambient (internal in the public typings): set on every node in an
 *  ambient context (a .d.ts file, `declare`, `declare global`). */
const AMBIENT_NODE_FLAG = (ts.NodeFlags as unknown as { Ambient: number }).Ambient;

const STRICT_TYPE_OPTION_NAMES: StrictTypeOptionName[] = [
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
];

/** garnet's own modules (`garnet:<name>`, docs/published_graphs_design.md):
 *  resolved to lib/garnet/<name>.ts beside the exporter; a project's own
 *  `paths` may still map the scheme. */
/** The Node modules garnet provides (docs/node_compat_design.md): `node:<name>` and the bare
 *  builtin names resolve to lib/node/<name>.ts; a project's own `paths` still win. */
const NODE_BUILTIN_MODULES = ["assert", "assert/strict", "buffer", "child_process", "crypto", "events", "fs",
  "fs/promises", "os", "path", "path/posix", "perf_hooks", "process", "readline", "stream", "string_decoder",
  "timers", "timers/promises", "url", "util", "worker_threads"];
function isNodeBuiltinSpecifier(spec: string): boolean {
  return spec.startsWith("node:") || NODE_BUILTIN_MODULES.includes(spec);
}
function garnetModulePaths(): ts.MapLike<string[]> {
  const lib = path.join(__dirname, "..", "lib");
  const paths: ts.MapLike<string[]> = {
    "garnet:*": [path.join(lib, "garnet", "*.ts")],
    "node:*": [path.join(lib, "node", "*.ts")],
  };
  for (const name of NODE_BUILTIN_MODULES) paths[name] = [path.join(lib, "node", name + ".ts")];
  return paths;
}
/** The Node globals and the prelude (docs/node_compat_design.md). When a module program
 *  imports a Node builtin or names one of the prelude's globals (`process`, `Buffer`, the
 *  timers, `URL`, ...) without declaring it, Node's environment is recreated with a prelude
 *  generated for the program (build/prelude/node_prelude_<parts>.ts: only the lib modules
 *  behind the globals the program, or the lib modules it imports, name), which
 *  computeModuleOrder evaluates first, and with lib/node/globals.d.ts unless @types/node
 *  already types the program. */
let nodePreludeFile: string | undefined;
/** lib/node's directory once the prelude is in use: a lib module's own ambient primitive
 *  (`__garnet_fetch`) is recognized by its declaration's file. */
let nodeLibDir: string | undefined;
const NODE_PRELUDE_GLOBALS = new Set(["process", "Buffer", "atob", "btoa", "setTimeout", "setInterval", "setImmediate", "clearTimeout",
  "clearInterval", "clearImmediate", "queueMicrotask", "structuredClone", "performance", "URL", "URLSearchParams", "global",
  // the Web standard objects (docs/web_fetch_api_design.md); `__garnet_StringObject` is named by a `new String(...)`
  "Headers", "Request", "Response", "FormData", "fetch", "DataView", "__garnet_StringObject",
  // Web Crypto (docs/web_crypto_design.md)
  "crypto", "Crypto", "SubtleCrypto", "CryptoKey"]);
/** The constructors among them: lib.dom declares the identifier, the prelude's class is the
 *  global object's value, and `new URL(...)` constructs through that value. */
const NODE_PRELUDE_CTORS = new Set(["URL", "URLSearchParams", "Headers", "Request", "Response", "FormData", "DataView", "__garnet_StringObject",
  "Crypto", "SubtleCrypto", "CryptoKey"]);
/** The lib modules behind the globals: a program's prelude imports only the parts it names,
 *  so a program that uses setTimeout does not compile the streams behind process.stdout. */
const NODE_PRELUDE_PARTS: { file: string; names: string[]; defaultImport?: string; triggers?: string[] }[] = [
  { file: "process", names: ["process"], defaultImport: "process" },
  // on demand (imported for its registration): the standard streams behind process.stdout/stderr/stdin
  { file: "tty", names: [], triggers: ["stdout", "stderr", "stdin"] },
  { file: "perf_hooks", names: ["performance"] },
  { file: "buffer", names: ["Buffer", "atob", "btoa"] },
  { file: "timers", names: ["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate"] },
  { file: "url", names: ["URL", "URLSearchParams"] },
  // the Web standard objects (docs/web_fetch_api_design.md)
  { file: "web/fetch", names: ["Headers", "Request", "Response", "FormData", "fetch"] },
  { file: "web/dataview", names: ["DataView"] },
  { file: "web/string_object", names: ["__garnet_StringObject"] },
  // Web Crypto (docs/web_crypto_design.md): the `crypto` global over node:crypto's digests and HMAC
  { file: "web/crypto", names: ["crypto", "Crypto", "SubtleCrypto", "CryptoKey"] },
  // on demand: fs.createReadStream / fs.createWriteStream (node:fs itself does not carry node:stream)
  { file: "fs/streams", names: [], triggers: ["createReadStream", "createWriteStream"] },
];
/** Property names that bring an on-demand module in (process.stdout, fs.createReadStream). */
const NODE_PRELUDE_TRIGGERS = new Set(NODE_PRELUDE_PARTS.flatMap((p) => p.triggers ?? []));
function nodePreludeSource(libNode: string, needed: Set<string>): string {
  const lines = [
    "// Generated by the exporter (docs/node_compat_design.md): the Node globals this program",
    "// names, installed on the global object before any module runs.",
  ];
  const fields = ["global: unknown", "queueMicrotask: unknown"];
  const assigns = ["g.global = globalThis;", "g.queueMicrotask = (callback: () => void): void => { Promise.resolve().then(callback); };"];
  for (const part of NODE_PRELUDE_PARTS) {
    const spec = JSON.stringify(path.join(libNode, part.file).split(path.sep).join("/"));
    if (part.triggers !== undefined) {
      if (part.triggers.some((n) => needed.has(n))) lines.push(`import ${spec};`);
      continue;
    }
    if (!part.names.some((n) => needed.has(n))) continue;
    // the module is compiled anyway: every global it provides is installed (a program
    // that names Buffer may reach btoa through a property, clearTimeout through a callback)
    lines.push(part.defaultImport !== undefined ? `import ${part.defaultImport} from ${spec};` : `import { ${part.names.join(", ")} } from ${spec};`);
    for (const n of part.names) { fields.push(`${n}: unknown`); assigns.push(`g.${n} = ${n};`); }
  }
  lines.push(`const g = globalThis as unknown as { ${fields.join("; ")} };`, ...assigns, "");
  return lines.join("\n");
}
/** The generated prelude's path (written only when its content changed; a concurrent
 *  compile writing the same content is harmless: the write is a rename). */
function writeNodePrelude(libNode: string, needed: Set<string>): string {
  const dir = path.join(__dirname, "..", "build", "prelude");
  fs.mkdirSync(dir, { recursive: true });
  const parts = NODE_PRELUDE_PARTS.filter((p) => (p.triggers ?? p.names).some((n) => needed.has(n))).map((p) => p.file.replace("/", "-"));
  const file = path.join(dir, `node_prelude_${parts.length === 0 ? "base" : parts.join("_")}.ts`);
  const content = nodePreludeSource(libNode, needed);
  let existing: string | undefined;
  try { existing = fs.readFileSync(file, "utf8"); } catch { existing = undefined; }
  if (existing !== content) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  }
  return file;
}
/** node:worker_threads (docs/node_compat_design.md, N5b). A worker is a fork of the
 *  initialized program (docs/fork_workers_design.md) that runs the top level of the module
 *  `new Worker(...)` names with `isMainThread` false. The module is named statically:
 *  `import.meta.url`, `new URL(import.meta.url)`, `new URL("./w.js", import.meta.url)`, or
 *  `fileURLToPath` of one of those. The named module's source is rewritten for the compiler
 *  (the checker sees the rewritten text at the same path): its imports and type
 *  declarations stay at the top level, its other statements become the body of a function
 *  `__garnet_worker_<n>` (exported), called once at the module's place when the module is part
 *  of the program's graph (a module only a worker runs is not), and each `new Worker` site
 *  passes that function in the file's place (a site in another module imports it). A module
 *  run as a worker cannot export values of its own or await at its top level. The child
 *  starts through the library's hook (host.setWorkerStart), which makes `isMainThread`,
 *  `threadId`, `workerData` and `parentPort` the worker's before the entry runs: the module's
 *  bindings are the parent's at the fork. */
function programWithWorkerEntries(program: ts.Program, rootNames: string[], options: ts.CompilerOptions,
                                  host: ts.CompilerHost, libNode: string): { program: ts.Program; host: ts.CompilerHost } {
  const workerModule = path.join(libNode, "worker_threads.ts");
  const checker = program.getTypeChecker();
  type Site = { file: ts.SourceFile; arg: ts.Expression; entry: string };
  const sites: Site[] = [];
  const unwrap = (e: ts.Expression): ts.Expression => {
    for (;;) {
      if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ||
          ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
      else return e;
    }
  };
  const isImportMetaUrl = (e: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(e) && ts.isMetaProperty(e.expression) &&
    e.expression.keywordToken === ts.SyntaxKind.ImportKeyword && e.name.text === "url";
  const calleeName = (e: ts.Expression): string | undefined =>
    ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
  // the module a `new Worker` argument names: "." for the file itself, a relative path, or nothing
  const specOf = (e: ts.Expression): string | undefined => {
    e = unwrap(e);
    if (isImportMetaUrl(e)) return ".";
    if (ts.isNewExpression(e) && calleeName(e.expression) === "URL" && e.arguments) {
      const args = e.arguments.map(unwrap);
      if (args.length === 1 && isImportMetaUrl(args[0])) return ".";
      if (args.length === 2 && ts.isStringLiteralLike(args[0]) && isImportMetaUrl(args[1])) return args[0].text;
      return undefined;
    }
    if (ts.isCallExpression(e) && calleeName(e.expression) === "fileURLToPath" && e.arguments.length === 1) return specOf(e.arguments[0]);
    return undefined;
  };
  const resolveEntry = (from: ts.SourceFile, spec: string): string | undefined => {
    if (spec === ".") return from.fileName;
    if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
    const base = path.resolve(path.dirname(from.fileName), spec);
    const stem = base.replace(/\.(m?[jt]s|tsx|cjs)$/, "");
    for (const c of [base, stem + ".ts", stem + ".mts", stem + ".tsx"]) if (/\.(ts|mts|tsx)$/.test(c) && fs.existsSync(c)) return c;
    return undefined;
  };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || program.isSourceFileDefaultLibrary(sf) || program.isSourceFileFromExternalLibrary(sf) ||
        sf.fileName.startsWith(libNode)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n)) {
        let sym = checker.getSymbolAtLocation(n.expression);
        if (sym && (sym.flags & ts.SymbolFlags.Alias)) sym = checker.getAliasedSymbol(sym);
        const decl = sym?.declarations?.[0];
        if (sym && sym.name === "Worker" && decl && decl.getSourceFile().fileName === workerModule) {
          const arg = n.arguments?.[0];
          const where = `${sf.fileName}:${sf.getLineAndCharacterOfPosition((arg ?? n).getStart(sf)).line + 1}`;
          const spec = arg ? specOf(arg) : undefined;
          if (arg === undefined || spec === undefined) {
            throw new Error(`UNSUPPORTED construct: new Worker(...) at ${where}: the worker's module must be named statically: import.meta.url, ` +
              `new URL(import.meta.url), new URL("./w.js", import.meta.url), or fileURLToPath of one of those (garnet resolves ` +
              `the module at compile time; a path string is relative to the working directory in Node, which the compiler does not know)`);
          }
          const entry = resolveEntry(sf, spec);
          if (entry === undefined) throw new Error(`UNSUPPORTED construct: new Worker(...) at ${where}: no module ${spec} beside ${sf.fileName}`);
          sites.push({ file: sf, arg, entry });
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  if (sites.length === 0) return { program, host };
  const entries = [...new Set(sites.map((s) => s.entry))];
  const nameOf = (entry: string): string => `__garnet_worker_${entries.indexOf(entry)}`;
  type Edit = { start: number; end: number; text: string };
  const edits = new Map<string, Edit[]>();
  const imports = new Map<string, Set<string>>();
  for (const site of sites) {
    const list = edits.get(site.file.fileName) ?? [];
    edits.set(site.file.fileName, list);
    list.push({ start: site.arg.getStart(site.file), end: site.arg.end, text: `${nameOf(site.entry)} as unknown as string` });
    if (site.entry !== site.file.fileName) {
      let rel = path.relative(path.dirname(site.file.fileName), site.entry).replace(/\\/g, "/").replace(/\.(ts|mts|tsx)$/, ".js");
      if (!rel.startsWith(".")) rel = "./" + rel;
      const set = imports.get(site.file.fileName) ?? new Set<string>();
      imports.set(site.file.fileName, set);
      set.add(`import { ${nameOf(site.entry)} } from "${rel}";`);
    }
  }
  // the text of [start, end) with the edits inside it applied
  const slice = (text: string, start: number, end: number, list: Edit[]): string => {
    let out = "";
    let pos = start;
    for (const e of list.filter((e) => e.start >= start && e.end <= end).sort((a, b) => a.start - b.start)) {
      out += text.slice(pos, e.start) + e.text;
      pos = e.end;
    }
    return out + text.slice(pos, end);
  };
  const texts = new Map<string, string>();
  const inGraph = new Set(program.getSourceFiles().map((f) => f.fileName));
  for (const file of new Set([...edits.keys(), ...entries])) {
    const sf = program.getSourceFile(file) ?? ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const list = edits.get(file) ?? [];
    const head = [...(imports.get(file) ?? [])];
    if (!entries.includes(file)) {
      texts.set(file, head.map((l) => l + "\n").join("") + slice(sf.text, 0, sf.text.length, list));
      continue;
    }
    const name = nameOf(file);
    const reject = (n: ts.Node, what: string): never => {
      throw new Error(`UNSUPPORTED construct: ${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: a module run as a worker ${what} (docs/node_compat_design.md)`);
    };
    const modifier = (n: ts.Node, kind: ts.SyntaxKind): boolean =>
      ts.canHaveModifiers(n) && (ts.getModifiers(n)?.some((m) => m.kind === kind) ?? false);
    const textOf = (n: ts.Node): string => slice(sf.text, n.getStart(sf), n.end, list);
    const awaitsAtTop = (n: ts.Node): boolean => {
      let found = false;
      const v = (m: ts.Node): void => {
        if (found || ts.isFunctionLike(m) || ts.isClassLike(m)) return;
        if (ts.isAwaitExpression(m) || (ts.isForOfStatement(m) && m.awaitModifier !== undefined)) { found = true; return; }
        m.forEachChild(v);
      };
      v(n);
      return found;
    };
    const kept: string[] = head;
    const moved: string[] = [];
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) ||
          modifier(st, ts.SyntaxKind.DeclareKeyword) || (ts.isEnumDeclaration(st) && modifier(st, ts.SyntaxKind.ConstKeyword)) ||
          (ts.isExportDeclaration(st) && st.isTypeOnly)) { kept.push(textOf(st)); continue; }
      if (ts.isExportDeclaration(st)) {
        if (st.exportClause && ts.isNamedExports(st.exportClause) && st.exportClause.elements.length === 0 && !st.moduleSpecifier) continue;
        reject(st, st.moduleSpecifier ? "re-exports a module" : "exports bindings (its top level is the worker's body, which nothing can import)");
      }
      if (ts.isExportAssignment(st) || ts.isNamespaceExportDeclaration(st)) reject(st, "has an export assignment");
      if (ts.isModuleDeclaration(st)) reject(st, "declares a namespace at its top level");
      if (modifier(st, ts.SyntaxKind.ExportKeyword)) reject(st, "exports a value (its top level is the worker's body, which nothing can import)");
      if (awaitsAtTop(st)) reject(st, "awaits at its top level");
      moved.push(textOf(st));
    }
    const call = inGraph.has(file) ? `${name}();\n` : "";
    texts.set(file, `// garnet: the module's top level is the body of ${name}, a worker's entry (docs/node_compat_design.md)\n` +
      kept.map((l) => l + "\n").join("") + `export function ${name}(): void {\n` + moved.map((l) => l + "\n").join("") + `}\n` + call);
  }
  const sub: ts.CompilerHost = Object.assign({}, host, {
    getSourceFile(fileName: string, languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions, onError?: (m: string) => void, shouldCreate?: boolean) {
      const text = texts.get(fileName) ?? texts.get(path.resolve(fileName));
      if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
      return host.getSourceFile(fileName, languageVersion, onError, shouldCreate);
    },
    readFile(fileName: string) { return texts.get(fileName) ?? texts.get(path.resolve(fileName)) ?? host.readFile(fileName); },
  });
  return { program: ts.createProgram(rootNames, options, sub), host: sub };
}

// ---- JSX (docs/jsx_react_ssr_design.md "The automatic runtime") ------------------------------------
/** The last `@<name>` pragma's factory argument of a file (`@jsx h`, `@jsxFrag F`, `@jsxImportSource x`,
 *  `@jsxRuntime automatic|classic`), or undefined. */
function jsxPragmaOf(sf: ts.SourceFile, name: string): string | undefined {
  type Pragma = { arguments?: { factory?: string } };
  const pragmas = (sf as unknown as { pragmas?: Map<string, Pragma | Pragma[]> }).pragmas;
  const p = pragmas?.get(name);
  const last = Array.isArray(p) ? p[p.length - 1] : p;
  return last?.arguments?.factory;
}

/** The import source of the automatic JSX runtime for `sf` (TypeScript's getJSXImplicitImportBase):
 *  the `@jsxImportSource` pragma, the `jsxImportSource` option, or "react" under `jsx: react-jsx` /
 *  `@jsxRuntime automatic`; undefined under the classic transform (`@jsxRuntime classic` says so). */
function jsxImplicitImportBase(options: ts.CompilerOptions, sf: ts.SourceFile): string | undefined {
  const runtime = jsxPragmaOf(sf, "jsxruntime");
  if (runtime === "classic") return undefined;
  const source = jsxPragmaOf(sf, "jsximportsource");
  if (options.jsx === ts.JsxEmit.ReactJSX || options.jsx === ts.JsxEmit.ReactJSXDev || options.jsxImportSource ||
      source || runtime === "automatic") return source || options.jsxImportSource || "react";
  return undefined;
}

/** The module the automatic runtime's `jsx`, `jsxs` and `Fragment` come from (`<source>/jsx-runtime`:
 *  the program is created under `jsx: react-jsx`, so the dev runtime's module is never asked for). */
function jsxRuntimeImportOf(options: ts.CompilerOptions, sf: ts.SourceFile): string | undefined {
  const base = jsxImplicitImportBase(options, sf);
  return base === undefined ? undefined : `${base}/jsx-runtime`;
}

/** The program, re-created under `jsx: react-jsx` when a file of it asks for the automatic runtime by
 *  pragma (`@jsxImportSource`, `@jsxRuntime automatic`): under that mode TypeScript adds the synthetic
 *  import of `<source>/jsx-runtime` to each JSX file (resolved, type-checked, part of the program). A
 *  project option says so directly (the options are then already in that mode). */
function programWithJsxRuntime(rootNames: string[], options: ts.CompilerOptions, host: ts.CompilerHost | undefined,
                               sourceMode: SourceMode): ts.Program {
  const program = programWithNodeSupport(rootNames, options, host, sourceMode);
  if (options.jsx === ts.JsxEmit.ReactJSX) return program;
  const automatic = program.getSourceFiles().some((f) => !f.isDeclarationFile && f.languageVariant === ts.LanguageVariant.JSX &&
    !program.isSourceFileDefaultLibrary(f) && !program.isSourceFileFromExternalLibrary(f) && jsxImplicitImportBase(options, f) !== undefined);
  if (!automatic) return program;
  return programWithNodeSupport(rootNames, { ...options, jsx: ts.JsxEmit.ReactJSX }, host, sourceMode);
}

/** The V8 oracle's JSX transform for a source (the classic one unless the file asks for the automatic
 *  runtime by pragma; a project's option is not seen here). */
function oracleJsxEmit(src: string): ts.JsxEmit {
  return /@jsxImportSource\b|@jsxRuntime\s+automatic\b/.test(src) ? ts.JsxEmit.ReactJSX : ts.JsxEmit.React;
}

/** A JSX child or factory argument: one value, or an array whose elements spread into the call. */
type JsxArg = { kind: "single" | "spread"; local: number };
/** How a JSX factory or runtime function is reached: the bundled function `fn` (called directly when it
 *  does not use `this`), the binding its declaration `name` names, or the `member` of the namespace
 *  import `ns` (`React.createElement`; the namespace object is the call's receiver). */
interface JsxCallee { fn?: number; name?: ts.Identifier; ns?: ts.Identifier; member?: string }
interface JsxRuntimeExports { jsx?: ts.Symbol; jsxs?: ts.Symbol; fragment?: ts.Symbol }
/** What a JSX element or fragment calls and reads: `call` (jsx / jsxs, or the classic factory), `value`
 *  (a fragment's type: Fragment, or the fragment factory), under the automatic `runtime` module. */
interface JsxSite { runtime?: ts.SourceFile; call?: JsxCallee; value?: JsxCallee }

/** The identifier a symbol's declaration binds (a variable, function, class, parameter, binding element,
 *  enum, or import binding), or undefined. */
function declarationNameOf(sym: ts.Symbol): ts.Identifier | undefined {
  for (const d of sym.declarations ?? []) {
    if (ts.isVariableDeclaration(d) || ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d) || ts.isParameter(d) ||
        ts.isBindingElement(d) || ts.isEnumDeclaration(d) || ts.isNamespaceImport(d) || ts.isImportSpecifier(d) || ts.isImportClause(d)) {
      const name = d.name;
      if (name && ts.isIdentifier(name)) return name;
    }
  }
  return undefined;
}

/** TypeScript's getSemanticJsxChildren: a child that is not whitespace-only text or an empty `{}`. */
function isSemanticJsxChild(c: ts.JsxChild): boolean {
  if (ts.isJsxExpression(c)) return !!c.expression;
  if (ts.isJsxText(c)) return !c.containsOnlyTriviaWhiteSpaces;
  return true;
}

/** The automatic runtime's `jsxs` form: several children, or one spread child (`{...xs}`). */
function jsxStaticChildren(children: readonly ts.JsxChild[]): boolean {
  const s = children.filter(isSemanticJsxChild);
  return s.length > 1 || (s.length === 1 && ts.isJsxExpression(s[0]) && !!s[0].dotDotDotToken);
}

/** TypeScript's hasKeyAfterPropsSpread: `<A {...p} key="k">`, where it falls back to createElement. */
function jsxKeyAfterSpread(node: ts.JsxOpeningLikeElement): boolean {
  let spread = false;
  for (const p of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(p) && (!ts.isObjectLiteralExpression(p.expression) || p.expression.properties.some(ts.isSpreadAssignment))) spread = true;
    else if (spread && ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "key") return true;
  }
  return false;
}

/** The property an attribute sets: `a`, `data-x`, or `xlink:href` (a namespaced name as one string). */
function jsxAttributeName(attr: ts.JsxAttribute): string {
  return ts.isJsxNamespacedName(attr.name) ? `${attr.name.namespace.text}:${attr.name.name.text}` : attr.name.text;
}

function programWithNodeSupport(rootNames: string[], options: ts.CompilerOptions, host: ts.CompilerHost | undefined,
                                sourceMode: SourceMode): ts.Program {
  nodePreludeFile = undefined;
  if (sourceMode === "script" || process.env.TSAOT_NODE_PRELUDE === "0") return ts.createProgram(rootNames, options, host);
  const libNode = path.join(__dirname, "..", "lib", "node");
  // node:worker_threads: the modules `new Worker(...)` names are compiled as entry functions
  // (programWithWorkerEntries); the host that serves the rewritten sources stays for the rounds below
  const workers = programWithWorkerEntries(ts.createProgram(rootNames, options, host), rootNames, options,
                                           host ?? ts.createCompilerHost(options), libNode);
  const program = workers.program;
  host = workers.host;
  const files = program.getSourceFiles();
  const checker = program.getTypeChecker();
  const isProjectFile = (f: ts.SourceFile): boolean =>
    !program.isSourceFileDefaultLibrary(f) && !program.isSourceFileFromExternalLibrary(f) && !f.fileName.startsWith(libNode);
  // A program that declares `process` itself (a host of its own, as the tsc-ts build does)
  // provides its own globals: neither the prelude nor globals.d.ts.
  const processSym = checker.resolveName("process", undefined, ts.SymbolFlags.Value, false);
  const processDecls = processSym?.declarations ?? [];
  if (processDecls.some((d) => isProjectFile(d.getSourceFile()))) return program;
  const hasTypesNode = processDecls.length > 0 || files.some((f) => /node_modules[\\/]@types[\\/]node[\\/]/.test(f.fileName));
  // an import the project's own `paths` map elsewhere is the project's module, not ours
  const ownMapped = (spec: string): boolean => {
    const targets = options.paths?.[spec];
    return targets !== undefined && !targets.some((t) => path.resolve(t).startsWith(libNode));
  };
  // The prelude globals a program names as free identifiers (ambient declarations), in its
  // own files and in the lib modules it imports (child_process names setTimeout).
  const namedGlobals = (prog: ts.Program, exclude: string | undefined): Set<string> => {
    const ck = prog.getTypeChecker();
    const found = new Set<string>();
    for (const f of prog.getSourceFiles()) {
      if (f.isDeclarationFile || prog.isSourceFileDefaultLibrary(f) || prog.isSourceFileFromExternalLibrary(f)) continue;
      if (exclude !== undefined && f.fileName === exclude) continue;
      // an on-demand module's trigger counts in the program's own files only: a lib module
      // naming process.stderr (util.debuglog) works with the minimal writer
      const triggers = f.fileName.startsWith(libNode) ? undefined : NODE_PRELUDE_TRIGGERS;
      const named = (text: string): boolean => NODE_PRELUDE_GLOBALS.has(text) || (triggers !== undefined && triggers.has(text));
      const visit = (n: ts.Node): void => {
        // a property named like a global (`globalThis.btoa`, `g.URL` through an alias of the
        // global object, `globalThis["performance"]`) counts too: conservative, and cheap
        if (ts.isPropertyAccessExpression(n) && named(n.name.text)) found.add(n.name.text);
        else if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && named(n.argumentExpression.text)) found.add(n.argumentExpression.text);
        if (ts.isIdentifier(n) && NODE_PRELUDE_GLOBALS.has(n.text) && !found.has(n.text) &&
            !((ts.isPropertyAccessExpression(n.parent) || ts.isPropertyAssignment(n.parent) ||
               ts.isPropertyDeclaration(n.parent) || ts.isMethodDeclaration(n.parent) || ts.isPropertySignature(n.parent) ||
               ts.isMethodSignature(n.parent)) && n.parent.name === n)) {
          const sym = ck.getSymbolAtLocation(n);
          if (!sym || !sym.declarations || sym.declarations.every((d) => d.getSourceFile().isDeclarationFile)) found.add(n.text);
        }
        // `new String(v)` constructs the prelude's wrapper class (docs/web_fetch_api_design.md)
        if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "String" && !found.has("__garnet_StringObject")) {
          const sym = ck.getSymbolAtLocation(n.expression);
          if (!sym || !sym.declarations || sym.declarations.every((d) => d.getSourceFile().isDeclarationFile)) found.add("__garnet_StringObject");
        }
        n.forEachChild(visit);
      };
      visit(f);
    }
    return found;
  };
  const userFiles = files.filter((f) => !f.isDeclarationFile && isProjectFile(f));
  let needs = files.some((f) => !f.isDeclarationFile && f.fileName.startsWith(libNode));
  for (const f of userFiles) {
    if (needs) break;
    const visit = (n: ts.Node): void => {
      if (needs) return;
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) &&
          isNodeBuiltinSpecifier(n.moduleSpecifier.text) && !ownMapped(n.moduleSpecifier.text)) { needs = true; return; }
      n.forEachChild(visit);
    };
    visit(f);
  }
  const needed = namedGlobals(program, undefined);
  if (!needs && needed.size === 0) return program;
  const typeRoots = hasTypesNode ? [] : [path.join(libNode, "globals.d.ts")];
  // the lib modules the prelude pulls in may name further globals: rescan until stable
  let current = program;
  for (let round = 0; round < 4; round++) {
    const preludePath = writeNodePrelude(libNode, needed);
    nodePreludeFile = preludePath;
    nodeLibDir = libNode;
    current = ts.createProgram([...rootNames, ...typeRoots, preludePath], options, host);
    let grew = false;
    for (const n of namedGlobals(current, preludePath)) if (!needed.has(n)) { needed.add(n); grew = true; }
    if (!grew) break;
  }
  return current;
}
function baseCompilerOptions(strict: boolean): ts.CompilerOptions {
  // strictNullChecks is forced ON independently of the `strict` flag so the
  // checker PRESERVES `null`/`undefined` in types (e.g. keeps `number | null` a
  // union instead of collapsing it to `number`). Without it, a nullable numeric
  // gets classified "primitive" and unboxed to a raw C double, silently losing
  // null/undefined at runtime. The aggressive type-driven optimizations remain
  // gated on the full strict profile (strictTypeOptimizations) — forcing only
  // strictNullChecks does not complete that profile, so non-strict programs keep
  // their previous optimization behavior; they just get sound nullability.
  return {
    target: ts.ScriptTarget.ES2020,
    strict,
    strictNullChecks: true,
    noEmit: true,
    // Bundler mode: follow ESM imports across the user's .ts files so the Program
    // contains the whole module graph and the checker resolves cross-file symbols
    // (the basis for symbol linking). `Bundler` resolution lets `import "./b"`
    // resolve to `./b.ts` without extensions, matching how editors/rolldown resolve.
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: garnetModulePaths(),
    // Preserve raw JSX nodes for the exporter's AOT lowering. The Node/V8 oracle
    // uses the classic React transform separately; no JavaScript is emitted here.
    jsx: ts.JsxEmit.Preserve,
  };
}

function effectiveStrictOption(opts: ts.CompilerOptions, name: StrictTypeOptionName): boolean {
  const explicit = (opts as Record<string, unknown>)[name];
  if (explicit !== undefined) return explicit === true;
  return opts.strict === true;
}

/** Classification of a `new <identifier>(...)` target (after built-ins), produced
 *  by resolveNewTarget and consumed by the dispatch in lowerExpr:
 *   - valueDynamic: a monomorphic class VALUE with an explicit ctor -> NewDynamic
 *     (construct through the runtime value K, which carries any captured cells).
 *   - functionValue: a plain FUNCTION value (ES5 constructor: a function
 *     declaration, or a binding whose type is callable) -> NewDynamic;
 *     ts_construct's class_id==0 arm runs [[Construct]] (proto = fn.prototype,
 *     this-bound call, return-override) and throws V8's catchable TypeError for
 *     non-constructables (arrows/methods/async/generators).
 *   - staticClass: a statically-known class (classId), or a no-ctor monomorphic
 *     class value, constructed in place; classId is undefined for an identifier
 *     that is neither a known class nor a built-in (the non-class loud-reject).
 *   - reject: a resolution-time loud-reject (non-monomorphic value, a no-ctor
 *     class value capturing a fn-local, or the dead polymorphic fallback). */
type NewTarget =
  | { kind: "valueDynamic"; classId: number }
  | { kind: "functionValue" }
  | { kind: "staticClass"; classId: number | undefined }
  | { kind: "reject"; reason: string };

type ClassValueEmit = { local: number; classValue: boolean };
/** What resolveIterator returns: the iterator local and the emitters of its protocol. */
type IterDriver = { itLocal: number; srcLocal: number; isAsync: boolean; step: (sentLocal: number) => number; throwStep?: (excLocal: number) => number; returnCall?: () => void };
/** One element of an array pattern bound from an iterator. */
type IterPatternElement = { node: ts.Node; omitted: boolean; rest: boolean; bind: (value: number) => void };

interface Local {
  id: number;
  typeId: number;
  refKind: RefKind;
  binding?: number;
  name?: string;
  nullableNumeric?: boolean;
  /** The kind of key the checker types this local as where it is a Map/Set
   *  key: "string" (string types, nullable or not) or "reference" (object,
   *  array or function types, nullable or not). A hint for the emitter's
   *  inline probe, which verifies the value's tag anyway. */
  tyKind?: "string" | "reference";
}
/** A scope record (capture context): the synthetic class holding one owner
 *  function's record-resident captured bindings. See docs/capture_contexts_design.md. */
interface CaptureRecord {
  classId: number;
  binding: number;               // synthetic binding id shared by every local that holds the record
  fields: Map<ts.Symbol, number>; // binding -> field id
  syms: ts.Symbol[];
}
/** One entry of a callee's capture layout: a whole scope record, or one cell. */
type CaptureSlot =
  | { kind: "record"; owner: ts.Node; binding: number; classId: number; syms: ts.Symbol[] }
  | { kind: "cell"; sym: ts.Symbol; binding: number }
  // docs/value_captures_design.md: an immutable binding travels as its value
  | { kind: "value"; sym: ts.Symbol; binding: number };

interface FnCtx {
  id: number;
  name: string;
  params: number[];
  locals: Local[];
  body: any[];
  localOfSymbol: Map<ts.Symbol, number>;
  cellAccess: Map<ts.Symbol, number>; // captured/owned cell binding -> local holding the cell
  recordLocals?: Map<ts.Node, number>; // capture contexts: owner function -> local holding its scope record
  recordAccess?: Map<ts.Symbol, { obj: number; field: number }>; // record-resident binding -> (record local, field)
  storageLocals?: Set<number>;         // canonical variable-slot locals (written in place by `=`/`++`);
                                       // a read of one ALIASES the slot, so it must be snapshotted when
                                       // a later sibling in the same expression mutates it (eval order).
  isExported: boolean;
  thisLocal?: number; // for methods: the local holding `this` (param 0)
  currentClass?: number; // for methods: the defining class id (for super.m())
  staticClass?: number; // for STATIC bodies: the defining class id, used only to resolve `super.X`
  paramClasses?: Record<string, number>; // param local id -> class id (typed-field codegen)
  restParam?: number; // local id of a rest parameter (...args), if any
  argumentsOffset?: number; // captured cells and receiver preceding JS arguments
  captureCount?: number;    // leading cell params (the closure environment)
  isAsync?: boolean;
  isGenerator?: boolean;
  // A named function expression binds its name only inside its own body:
  // `const f = function self(){ return self(); }`.
  selfFunctionSymbol?: ts.Symbol;
  // Stack of enclosing loop kinds. Switches use a one-pass IR loop, so an
  // unlabeled continue skips their entries when resolving its actual target.
  loopStack?: string[];
  loopLabels?: (string | undefined)[]; // label of each loop on loopStack (parallel)
  pendingLabel?: string;               // label to attach to the next loop entered
  hoistedFns: Set<ts.Node>;            // function decls already hoisted at prologue (Step D)
  ownThisCells?: Set<number>;          // lexical-this cells this function made (not an inherited parameter)
  thisCellOfBody?: Map<any[], number>; // the lexical-this cell made in a block, reused by its later arrows
}

/** The program's build-time constants (TSAOT_DEFINE="__DEV__=false,__BROWSER__=true,__VERSION__=\"3.5.0\""):
 *  an ambient identifier so named is the constant, and a condition it decides compiles only the
 *  branch taken (a bundler's `define`; vue's flags, docs/real_projects.md). A value is true, false, a
 *  number or a quoted string (no comma inside). */
function parseDefines(): Map<string, boolean | number | string> {
  const out = new Map<string, boolean | number | string>();
  const spec = process.env.TSAOT_DEFINE;
  if (!spec) return out;
  for (const part of spec.split(",").map((p) => p.trim()).filter((p) => p.length > 0)) {
    const m = /^([A-Za-z_$][\w$]*)=(.*)$/.exec(part);
    if (!m) { console.error(`TSAOT_DEFINE: expected NAME=VALUE, got '${part}'`); process.exit(2); }
    const name = m[1], raw = m[2];
    let value: boolean | number | string;
    if (raw === "true" || raw === "false") value = raw === "true";
    else if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) value = Number(raw);
    else if (/^(".*"|'.*')$/.test(raw)) value = raw.slice(1, -1);
    else { console.error(`TSAOT_DEFINE: the value of ${name} must be true, false, a number or a quoted string, got '${raw}'`); process.exit(2); }
    out.set(name, value);
  }
  return out;
}
function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}
function isLoopStatement(n: ts.Node): boolean {
  return (
    ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) ||
    ts.isWhileStatement(n) || ts.isDoStatement(n)
  );
}
type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
function isLiftable(n: ts.Node): n is FnLike {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
}
/** An object-literal method or accessor member (`{ m(){}, get x(){}, set x(v){} }`).
 *  These are lifted like function expressions (this = object) and, like arrows,
 *  capture outer variables — so the free-var / cell machinery must treat them as
 *  nested function boundaries (collectNested/freeVars), not opaque skips. */
function isObjLitFn(n: ts.Node): boolean {
  return (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n))
    && !!(n as ts.MethodDeclaration).body
    && !!n.parent && ts.isObjectLiteralExpression(n.parent);
}

class Exporter {
  checker: ts.TypeChecker;
  // Untyped mode (TSAOT_UNTYPED=1): treat the whole program as `any` — disable
  // ALL type-driven lowering (no unbox/SROA via classify, no generic
  // specialization). Every value stays boxed and goes the fully dynamic runtime
  // path, which is exactly what genuinely-`any` code already does today, so it
  // is semantically sound JS (slower, but never a silent miscompile). This is
  // the escape hatch for ill-typed input: the checker's types are unsound under
  // type errors, so we simply stop trusting them rather than running dangerous
  // unboxing on false types.
  untyped = process.env.TSAOT_UNTYPED === "1";
  funcSymbols = new Map<ts.Symbol, number>();
  /// fn ids whose declaration has an explicit `this` parameter (so the callee
  /// reads args[0] as this). Direct calls to these must prepend an undefined this.
  funcTakesThisIds = new Set<number>();
  moduleVars = new Set<ts.Symbol>();
  /** A module-level `const f = (...) => ...` (or function expression) that reads neither `this` nor
   *  `arguments` and captures nothing: a call of `f` is a direct call of its function (the binding
   *  is read first where the call may run before the declaration, the TDZ). Modern TypeScript
   *  declares most helpers this way (vue's isObject, hasOwn, isRef: a function-value call each). */
  constFnSymbols = new Map<ts.Symbol, number>();
  /** module-level `const f = NS.member` bindings naming a builtin function value (`isArray = Array.isArray`):
   *  a call through one is the builtin's static call (builtinAliasCallName) */
  constBuiltinAliases = new Map<ts.Symbol, { ns: string; member: string }>();
  /** module-level `const m = Object.prototype.hasOwnProperty | toString`: `m.call(x, ...)` is the runtime's implementation */
  constProtoMethodAliases = new Map<ts.Symbol, string>();
  scriptGlobalVarSyms = new Set<ts.Symbol>();
  scriptGlobalVarNames = new Set<string>();
  moduleTopBindingByName = new Map<string, ts.Symbol>();
  mutatedGlobalNames = new Set<string>();
  mutatedGlobalMembers = new Set<string>();
  globalObjectAliasPaths = new Map<string, string[]>();
  stringConstValues = new Map<string, string>();
  // Step C: the synthesized `__module_init` FunctionDeclaration (holds top-level
  // non-declaration statements). Module-scope bindings are treated as owned by
  // this function so nested top-level functions capture them as cells.
  moduleInitNode: ts.FunctionDeclaration | undefined;
  moduleInitId: number | undefined;
  // Symbols declared at module scope (top-level var/let/const + top-level
  // function/class names). Used to redirect symbolOwnerFunction to moduleInitNode.
  moduleScopeSyms = new Set<ts.Symbol>();
  /** JSX (docs/jsx_react_ssr_design.md): per file, the automatic runtime's module (undefined under the
   *  classic transform) and whether it has a JSX element; per runtime module, the exports it calls. */
  jsxRuntimeModules = new Map<ts.SourceFile, ts.SourceFile | undefined>();
  jsxFiles = new Map<ts.SourceFile, boolean>();
  jsxRuntimeExports = new Map<ts.SourceFile, JsxRuntimeExports>();
  jsxSites = new Map<ts.Node, JsxSite>();
  // value namespaces already materialized (so repeated `namespace N {}` merge).
  materializedNamespaces = new Set<ts.Symbol>();
  private namespaceBindings = new Map<ts.Symbol, { namespace: ts.Identifier; name: string }>();
  private moduleNamespaceLocals = new Map<ts.Symbol, number>();
  private namespaceGetterFunctions = new Map<ts.Symbol, number>();
  private moduleInitializationOrder = new Map<ts.SourceFile, number>();
  // Bundler: the user's modules in ESM execution order (dependencies before
  // dependents = DFS post-order). For a single-file program this is just [entry].
  // All per-file passes iterate this list; __module_init concatenates every
  // module's top-level statements in this order (rolldown-style scope hoisting).
  modules: ts.SourceFile[] = [];
  // Modules that participate in an import cycle (a back-edge in the dep graph).
  // Used to loud-reject cross-module TDZ reads of lexical bindings at module-init
  // scope, which would otherwise be a silent miscompile (ESM throws a TDZ
  // ReferenceError when a cyclic module reads another's const/let/class before it
  // is initialized; the bundler's scope-hoisting would just read the unset local).
  cyclicModules: Set<ts.SourceFile> = new Set();
  /** The build-time constants (TSAOT_DEFINE, `parseDefines`). */
  defines: Map<string, boolean | number | string> = parseDefines();
  // True when the program has top-level await, so __module_init is lowered as an
  // async coroutine (driven by the event loop) rather than a synchronous function.
  moduleInitIsAsync = false;
  // Step E: module-scope bindings captured by a METHOD body. Methods are
  // dispatched via the class vtable with a fixed ABI ([this, args]), so they
  // cannot receive captured cells as leading parameters the way plain functions
  // do. Instead, the cell OBJECT for such a binding is published into a GLOBALS[]
  // slot by __module_init, and the method reads the cell from there (LoadGlobal)
  // then reads .VALUE. Maps the binding symbol -> its GlobalId.
  moduleCellGlobal = new Map<ts.Symbol, number>();
  // Stable boxed values for top-level module function declarations. Direct calls
  // still use the raw cfunc path; value reads (`f`, `f.prototype`, callbacks)
  // load the one closure stored here, preserving identity and own-prototype state.
  functionValueGlobal = new Map<ts.Symbol, number>();
  functionValuesInitNode: ts.FunctionDeclaration | undefined;
  functionValuesInitId: number | undefined;
  // Step F: static members. Each class with any static field/block/method gets a
  // GLOBALS[] slot holding a "static container" object; static fields live as
  // properties on it. classStaticGlobal: classId -> GlobalId. Static methods are
  // plain functions (not vtable methods) keyed classId:static:<name> -> fnId.
  // staticInitNodes: synthetic per-class init functions (create container, run
  // static field inits + static blocks in source order), called at entry between
  // ts_register_classes() and __module_init().
  classStaticGlobal = new Map<number, number>();
  classStaticFieldNames = new Map<number, Set<string>>();   // classId -> own static field names
  // Synthetic symbol representing an arrow's lexical `this`. Arrows that use
  // `this` capture the enclosing function's `this` value through a cell keyed by
  // this sentinel (reusing the normal cell-threading path). Created lazily.
  _lexicalThisSym?: ts.Symbol;
  get lexicalThisSym(): ts.Symbol {
    if (!this._lexicalThisSym) this._lexicalThisSym = { name: "<this>", flags: 0 } as unknown as ts.Symbol;
    return this._lexicalThisSym;
  }
  staticMethodFunc = new Map<string, number>(); // `${classId}:static:${name}` -> fnId
  staticGetterFunc = new Map<string, number>(); // `${classId}:static:${name}` -> fnId (static get)
  staticSetterFunc = new Map<string, number>(); // `${classId}:static:${name}` -> fnId (static set)
  staticInits: { classId: number; fnId: number; node: ts.ClassLikeDeclaration }[] = [];
  fnId = new Map<ts.Node, number>();
  // classId -> synthesized class-value constructor fnId (memo); -1 = cannot synth
  // (field initializer captures an enclosing function local, unrepresentable in a
  // top-level synthetic ctor). Used so no-ctor classes become proper ts_func values.
  synthCtorMemo = new Map<number, number>();
  bindingId = new Map<ts.Symbol, number>();
  cellBindings = new Set<ts.Symbol>();
  // Capture by value (docs/value_captures_design.md): bindings assigned anywhere
  // other than their declaration; bindings that must stay cells because a
  // creation site of unknown order captures them; the functions capturing each
  // binding; and the bindings that travel by value (removed from cellBindings).
  assignedSyms = new Set<ts.Symbol>();
  assignmentSites = new Map<ts.Symbol, ts.Node[]>();   // every assignment target (identifier node) per binding
  cellOnlySyms = new Set<ts.Symbol>();
  capturedByFns = new Map<ts.Symbol, FnLike[]>();
  valueBindings = new Set<ts.Symbol>();
  valueCaptures = process.env.TSAOT_VALUE_CAPTURES !== "0";
  // Lazy closure values (docs/lazy_function_values_design.md): a nested
  // declaration used as a value gets its closure on first use per activation.
  lazyFnValues = process.env.TSAOT_LAZY_FN_VALUES !== "0";
  // Splice fast paths (docs/splice_fast_paths_design.md).
  spliceFast = process.env.TSAOT_SPLICE_FAST !== "0";
  lazyFnValueSyms = new Set<ts.Symbol>();
  // Capture contexts (docs/capture_contexts_design.md): the scope record of each
  // owner function and the owner of every record-resident binding.
  captureContexts = false;
  // Function declarations referenced anywhere as a VALUE (not just called
  // directly). A nested declaration outside this set never needs its hoisted
  // closure: direct calls thread the scope record instead.
  fnValueUsed = new Set<ts.Symbol>();
  lazyFnDecls = false;
  // Nested function declarations registered as direct-call targets (their
  // scope records are threaded like module cells). TSAOT_NESTED_DIRECT=0
  // keeps them as closure values called through ts_call_value.
  nestedFuncSymbols = new Set<ts.Symbol>();
  /** nested declaration fn ids whose lowering is deferred to the driver */
  pendingNestedFns = new Set<number>();
  nestedDirect = process.env.TSAOT_NESTED_DIRECT !== "0";
  /** TSAOT_COND_FLAGS=0: `&&` / `||` in condition position lower as values again (docs/static_micro_patterns_design.md, 4). */
  condFlags = process.env.TSAOT_COND_FLAGS !== "0";
  // Function declarations in the body of a value namespace registered as
  // direct-call targets (their free variables are module-scope bindings, so
  // calls thread the module cells like calls to top-level functions). A
  // reference other than as a callee still captures the closure value that
  // lowerModuleDeclaration binds. TSAOT_NAMESPACE_DIRECT=0 keeps every call
  // through the closure value.
  namespaceFuncSymbols = new Set<ts.Symbol>();
  namespaceDirect = process.env.TSAOT_NAMESPACE_DIRECT !== "0";
  // An interface that extends Array/ReadonlyArray (the compiler's
  // NodeArray<T>) denotes a runtime array; TSAOT_ARRAY_INTERFACES=0 keeps
  // such receivers dynamic (generic iteration, dynamic method dispatch).
  arrayInterfaces = process.env.TSAOT_ARRAY_INTERFACES !== "0";
  recordOfOwner = new Map<ts.Node, CaptureRecord>();
  recordOwnerOf = new Map<ts.Symbol, ts.Node>();
  moduleCtxGlobal: number | undefined = undefined;
  freeCache = new Map<ts.Node, Set<ts.Symbol>>();
  // freeVars fixpoint state: per-round results, previous-round results (used as
  // the value for in-progress nodes on call cycles), and the in-progress guard.
  freePass = new Map<ts.Node, Set<ts.Symbol>>();
  freePrev = new Map<ts.Node, Set<ts.Symbol>>();
  freeInProgress = new Set<ts.Node>();
  declaredCache = new Map<ts.Node, Set<ts.Symbol>>();
  fieldMap = new Map<string, number>();
  globalMap = new Map<string, number>();
  // Optional-chaining (`?.`) short-circuit support. `optChainBound` memoizes the
  // value of a guard receiver (the `.expression` of a `?.` link) so the outer
  // chain lowering reuses it instead of re-evaluating (preserving side effects).
  // `optChainSkip` marks a chain root currently being lowered for its value, so
  // the root-interception in lowerExpr is bypassed once we're inside it.
  optChainBound = new Map<ts.Node, number>();
  optChainSkip = new Set<ts.Node>();
  fields: { id: number; name: string; declaringType: number }[] = [];
  globals: { id: number; name: string }[] = [];
  functions: any[] = [];
  /* Each function's source module (docs/build_split_design.md): the native
     build's units group functions by module, so an edit recompiles its own
     module's units. Synthetic functions take the module being lowered when
     they are made. */
  moduleNames: string[] = [];
  moduleIds = new Map<string, number>();
  fnModule = new Map<number, number>();
  curModuleFile: string | undefined;
  moduleId(fileName: string): number {
    let id = this.moduleIds.get(fileName);
    if (id === undefined) { id = this.moduleNames.length; this.moduleNames.push(fileName); this.moduleIds.set(fileName, id); }
    return id;
  }
  /* The module paths relative to the directory that contains them all, so
     the units do not depend on where the build runs. */
  relativeModuleNames(): string[] {
    // a root file given relative to the working directory keeps its relative name
    const files = this.moduleNames.map((f) => path.resolve(f).split(path.sep).join("/"));
    const under = (d: string, c: string) => d === c || d.startsWith(c.endsWith("/") ? c : c + "/");
    let common = files.length > 0 ? path.posix.dirname(files[0]) : "";
    for (const f of files) {
      while (!under(path.posix.dirname(f), common)) {
        const up = path.posix.dirname(common);
        if (up === common) break;
        common = up;
      }
    }
    return files.map((f) => path.posix.relative(common, f));
  }
  noteFnModule(fnId: number, fileName: string | undefined = this.curModuleFile): void {
    if (fileName !== undefined) this.fnModule.set(fnId, this.moduleId(fileName));
  }
  private templateObjectGlobals = new Map<ts.TaggedTemplateExpression, number>();
  private hasDynamicDelete = false;
  // fnIds whose body has already been lowered, so lowerFunctionLike is idempotent.
  // A closure node may be lowered more than once (e.g. a class with no explicit
  // ctor that is `new`'d at several sites inlines its field-initializer closures
  // per site); without this guard `this.functions` would carry duplicate same-id
  // entries (sorted-but-not-deduped at output -> a C redefinition).
  loweredFnIds = new Set<number>();
  exports: number[] = [];
  site = 0;
  labels: Record<number, string> = {};
  siteMeta: { site: number; multiplicity: "once" | "many"; layoutDeterminable: boolean; kind: string }[] = [];
  siteSpans: {
    site: number; kind: string; synthetic: boolean;
    line: number; col: number; endLine: number; endCol: number; text: string;
  }[] = [];
  sf!: ts.SourceFile;
  strictTypeProfileCache?: { sf: ts.SourceFile | undefined; profile: StrictTypeOptimizationProfile };
  genericInferenceSafety = new WeakMap<ts.FunctionDeclaration, boolean>();
  VALUE: number;
  DATE_MS_FIELD: number;

  // ---- class support ----
  classExtractor!: ClassExtractor;
  /** docs/closed_receivers_design.md: no runtime point that raises
   *  g_typed_slow is reachable (TSAOT_CLOSED_RECEIVERS=0 records it open). */
  closedReceivers: ClosedReceivers = { closed: false, reasons: ["not analyzed"], count: 1 };
  classInfos: ClassInfo[] = [];
  /** Class id of the synthetic captured-variable cell class (typed cells), or
   *  undefined when TSAOT_TYPED_CELLS=0. */
  cellClassId: number | undefined = undefined;
  classSymToId = new Map<ts.Symbol, number>();
  /** class declaration/expression AST node -> class id. Covers anonymous class
   *  expressions (`const C = class {}`) that have no name symbol to key by. */
  classIdByNode = new Map<ts.Node, number>();
  /** class id -> its declaration node (for generic class specialization/cloning). */
  classNodeOfId = new Map<number, ts.ClassLikeDeclaration>();
  /** Cache of class specializations: "classId|tag" -> specialized class id. */
  genClassSpecializations = new Map<string, number>();
  nameIntern = new Map<string, number>();
  /** (classId, methodName) -> FunctionId of the lifted method body. */
  methodFunc = new Map<string, number>();
  /** AST node of each method declaration we must lift, with its assigned id. */
  methodDecls: { node: ts.FunctionLikeDeclaration; fnId: number; classId: number; thisName: string }[] = [];
  classesOut: any[] = [];
  unsupportedList: string[] = [];

  constructor(private program: ts.Program, private sourceMode: SourceMode = "module") {
    this.checker = program.getTypeChecker();
    this.VALUE = this.internField("__value");
    this.DATE_MS_FIELD = this.internField("__date_ms");
  }

  /** Reject legal syntax whose runtime semantics would otherwise be silently
   *  erased because it is stored as declaration metadata or node flags. */
  preflightRuntimeSyntax(sf: ts.SourceFile): void {
    const visit = (node: ts.Node) => {
      const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
      if (decorators?.length) {
        this.unsupported(node, "decorators (standard and experimental evaluation is not implemented)");
      }
      if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using)) {
        this.unsupported(node, "`using` / `await using` explicit resource management");
      }
      if (ts.isPropertyDeclaration(node) &&
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AccessorKeyword)) {
        this.unsupported(node, "auto-accessor class fields");
      }
      if (ts.isMetaProperty(node)) {
        this.unsupported(node, `${node.getText()} meta-property`);
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.attributes) {
        this.unsupported(node, "import/export attributes");
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }

  strictTypeOptimizationProfile(): StrictTypeOptimizationProfile {
    if (this.strictTypeProfileCache && this.strictTypeProfileCache.sf === this.sf) {
      return this.strictTypeProfileCache.profile;
    }
    // Untyped mode disables every type-driven optimization unconditionally.
    if (this.untyped) {
      const optionValues = {} as Record<StrictTypeOptionName, boolean>;
      for (const name of STRICT_TYPE_OPTION_NAMES) optionValues[name] = false;
      const profile: StrictTypeOptimizationProfile = {
        enabled: false, strictProfile: false, diagnosticClean: false,
        diagnosticCount: 0, reason: "untyped", options: optionValues,
      };
      this.strictTypeProfileCache = { sf: this.sf, profile };
      return profile;
    }
    const opts = this.program.getCompilerOptions();
    const optionValues: Record<StrictTypeOptionName, boolean> = {} as Record<StrictTypeOptionName, boolean>;
    for (const name of STRICT_TYPE_OPTION_NAMES) optionValues[name] = effectiveStrictOption(opts, name);
    const strictProfile = STRICT_TYPE_OPTION_NAMES.every((name) => optionValues[name]);
    // Bundler: the program is sound only if EVERY module type-checks cleanly, so
    // gather diagnostics across all modules (single-file: this.modules === [sf]).
    const diagMods = this.modules.length ? this.modules : (this.sf ? [this.sf] : []);
    const diagnostics = strictProfile && this.sf
      ? [
          ...diagMods.flatMap((m) => this.program.getSyntacticDiagnostics(m)),
          ...diagMods.flatMap((m) => this.program.getSemanticDiagnostics(m)),
          ...this.program.getOptionsDiagnostics(),
        ]
      : [];
    const diagnosticClean = strictProfile && this.sf !== undefined && diagnostics.length === 0;
    const enabled = strictProfile && diagnosticClean;
    const profile: StrictTypeOptimizationProfile = {
      enabled,
      strictProfile,
      diagnosticClean,
      diagnosticCount: diagnostics.length,
      reason: enabled
        ? "enabled"
        : (!strictProfile ? "strictProfileIncomplete" : "typeDiagnostics"),
      options: optionValues,
    };
    this.strictTypeProfileCache = { sf: this.sf, profile };
    return profile;
  }

  strictTypeOptimizationsEnabled(): boolean {
    return this.strictTypeOptimizationProfile().enabled;
  }

  internField(name: string): number {
    let id = this.fieldMap.get(name);
    if (id === undefined) {
      id = this.fields.length;
      this.fieldMap.set(name, id);
      this.fields.push({ id, name, declaringType: 0 });
    }
    return id;
  }
  internGlobal(name: string): number {
    let id = this.globalMap.get(name);
    if (id === undefined) {
      id = this.globals.length;
      this.globalMap.set(name, id);
      this.globals.push({ id, name });
    }
    return id;
  }
  bindingIdOf(s: ts.Symbol): number {
    let id = this.bindingId.get(s);
    if (id === undefined) {
      id = this.bindingId.size;
      this.bindingId.set(s, id);
    }
    return id;
  }
  internName(name: string): number {
    let id = this.nameIntern.get(name);
    if (id === undefined) {
      id = this.nameIntern.size;
      this.nameIntern.set(name, id);
    }
    return id;
  }

  classify(t: ts.Type): RefKind {
    // Untyped mode: never claim to know a type's ref kind. "unknown" is the
    // conservative boxed bucket — no unbox, no specialization — so every value
    // is handled by the dynamic runtime path (correct JS `any` semantics).
    if (this.untyped) return "unknown";
    const F = ts.TypeFlags;
    // Generic specialization: if this is a type parameter we're currently
    // monomorphizing (T -> concrete), classify by the concrete substitution.
    if (t.flags & F.TypeParameter) {
      const name = (t.symbol && t.symbol.name) || undefined;
      if (name && this.typeSubst && this.typeSubst.has(name)) {
        return this.typeSubst.get(name)!.refKind;
      }
      return "unknown";
    }
    if (t.flags & F.Object) return "reference";
    if (t.flags & F.Union) {
      const u = t as ts.UnionType;
      let anyRef = false, allPrim = true, hasNumber = false, hasNullish = false;
      for (const m of u.types) {
        const k = this.classify(m);
        if (k === "reference") anyRef = true;
        if (k !== "primitive") allPrim = false;
        if (m.flags & F.NumberLike) hasNumber = true;
        if (m.flags & (F.Void | F.Undefined | F.Null)) hasNullish = true;
      }
      if (anyRef) return "reference";
      // `number | undefined/void/null` (e.g. an iterator result's `.value`):
      // unboxing to a raw C double would turn the nullish case into NaN — a
      // silent miscompile. Keep it boxed so undefined stays undefined.
      if (hasNumber && hasNullish) return "reference";
      if (allPrim) return "primitive";
      return "unknown";
    }
    // "primitive" means an unboxable scalar (held as raw C double). Numbers are
    // the unboxables. Booleans are NaN-boxed tagged values (not raw doubles) —
    // unboxing them as doubles makes ts_to_num produce NaN — so they stay boxed
    // ("reference") and use ts_truthy for conditions. Strings/symbols/bigints
    // are heap-boxed too.
    // `never` is NOT unboxable: although it's the bottom type, a deliberate cast
    // (`value as never`) carries a real runtime value (often a reference, e.g. an
    // array), and a never-typed return slot may hold undefined. Unboxing it to a
    // raw double would coerce that value to NaN/null. Classify it as "unknown"
    // (boxed) so the runtime value is preserved.
    // Nullish values must retain their tags. A property narrowed to undefined
    // can also be initialized by a call that TypeScript's flow model does not
    // invalidate; converting the later read to double loses that object too.
    const unboxable = F.NumberLike;
    if (t.flags & (F.StringLike | F.ESSymbolLike | F.BigIntLike | F.BooleanLike)) return "reference";
    if (t.flags & unboxable) return "primitive";
    return "unknown";
  }
  /** `iterResult.value` can be `undefined` at runtime (an exhausted iterator),
   *  yet TypeScript types it as the yield/return type (e.g. `number`) — it does
   *  not model the done-with-no-value case. Unboxing it to a raw double would turn
   *  that undefined into NaN. Detect a `.value` read whose receiver is an
   *  iterator-result-like object (has a sibling `done` property) and keep it boxed. */
  private isIteratorResultValueAccess(node: ts.Node): boolean {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== "value") return false;
    try {
      const rt = this.checker.getTypeAtLocation(node.expression);
      return !!rt.getProperty("done") && !!rt.getProperty("value");
    } catch {
      return false;
    }
  }
  refKindOf(node: ts.Node): RefKind {
    if (this.untyped) return "unknown";
    try {
      if (this.isIteratorResultValueAccess(node)) return "reference";
      return this.classify(this.checker.getTypeAtLocation(node));
    } catch {
      return "unknown";
    }
  }
  /** True when `node`'s static type is ONLY null/undefined/void/never (no real
   *  value member). With strictNullChecks a receiver can narrow to exactly `null`
   *  (e.g. `const x: C | null = null`), and such a type classifies as "primitive"
   *  even though it is not a number — used to avoid mis-rejecting a property access
   *  on a statically-nullish receiver as a numeric-receiver access. */
  typeIsNullishOnly(node: ts.Node): boolean {
    try {
      const F = ts.TypeFlags;
      const t = this.checker.getTypeAtLocation(node);
      const isNullish = (m: ts.Type) => (m.flags & (F.Null | F.Undefined | F.Void | F.Never)) !== 0;
      if (t.flags & F.Union) return (t as ts.UnionType).types.every(isNullish);
      return isNullish(t);
    } catch {
      return false;
    }
  }
  /** True when `node`'s static type is a *pure `number | undefined`* (also void)
   *  — a subset of the `classify`-boxed nullable numbers. §261 marks element-read
   *  destinations with this so the analyzer can recover perf by unboxing the
   *  arithmetic-only ones (flow-sensitive) while observed reads stay boxed.
   *
   *  `null` is deliberately EXCLUDED: the unbox uses `ts_to_num` (a raw bit
   *  reinterpret), under which `undefined`→NaN happens to equal `ToNumber(undefined)`,
   *  but `null`→NaN ≠ `ToNumber(null)` (=0). So `(number|null)[]` stays boxed
   *  (§254-correct; the boxed path coerces null→0 via `numc`). */
  typeIsNullableNumeric(node: ts.Node): boolean {
    try {
      const F = ts.TypeFlags;
      const t = this.checker.getTypeAtLocation(node);
      if (!(t.flags & F.Union)) return false;
      let anyRef = false, hasNumber = false, hasUndef = false, hasNull = false;
      for (const m of (t as ts.UnionType).types) {
        if (this.classify(m) === "reference") anyRef = true;
        if (m.flags & F.NumberLike) hasNumber = true;
        if (m.flags & (F.Void | F.Undefined)) hasUndef = true;
        if (m.flags & F.Null) hasNull = true;
      }
      return hasNumber && hasUndef && !hasNull && !anyRef;
    } catch {
      return false;
    }
  }
  /** Mark `localId` as a pure-nullable-number element read (see
   *  `typeIsNullableNumeric`) when `node`'s type qualifies. */
  markNullableNumeric(ctx: FnCtx, localId: number, node: ts.Node): void {
    if (this.typeIsNullableNumeric(node)) ctx.locals[localId].nullableNumeric = true;
  }

  typeHasAnyOrUnknown(t: ts.Type): boolean {
    const F = ts.TypeFlags;
    if (t.flags & (F.Any | F.Unknown)) return true;
    if (t.flags & (F.Union | F.Intersection)) {
      return ((t as ts.UnionOrIntersectionType).types ?? []).some((m) => this.typeHasAnyOrUnknown(m));
    }
    return false;
  }

  typeSpecForType(t: ts.Type, depth = 0): TypeSpec | undefined {
    if (depth > 6) return undefined;
    const F = ts.TypeFlags;
    if (this.typeHasAnyOrUnknown(t)) return undefined;
    if (t.flags & F.TypeParameter) {
      const name = (t.symbol && t.symbol.name) || undefined;
      if (name && this.typeSubst?.has(name)) return this.typeSubst.get(name);
      return undefined;
    }
    if (t.flags & F.NumberLike) return { kind: "number", key: "number", refKind: "primitive" };
    if (t.flags & F.StringLike) return { kind: "string", key: "string", refKind: "reference" };
    if (t.flags & F.Undefined) return { kind: "undefined", key: "undefined", refKind: "primitive" };
    if (t.flags & F.Null) return { kind: "null", key: "null", refKind: "primitive" };
    if (t.flags & F.Union) {
      const u = t as ts.UnionType;
      if (u.types.length === 0) return undefined;
      const specs = u.types.map((m) => this.typeSpecForType(m, depth + 1));
      if (specs.every((s) => s?.kind === "number")) return { kind: "number", key: "number", refKind: "primitive" };
      if (specs.every((s) => s?.kind === "string")) return { kind: "string", key: "string", refKind: "reference" };
      return undefined;
    }
    const anyChecker = this.checker as any;
    let isArray = false;
    try {
      isArray = (typeof anyChecker.isArrayType === "function" && anyChecker.isArrayType(t)) ||
        (typeof anyChecker.isTupleType === "function" && anyChecker.isTupleType(t));
    } catch {
      isArray = false;
    }
    if (isArray) {
      const elemType = this.checker.getIndexTypeOfType(t, ts.IndexKind.Number);
      if (!elemType) return undefined;
      const elem = this.typeSpecForType(elemType, depth + 1);
      if (!elem) return undefined;
      return { kind: "array", key: `array_${elem.key}`, refKind: "reference", elem };
    }
    return undefined;
  }

  /** The key kind of a collection key expression by its checker type, null
   *  and undefined members set aside: every member string-like -> "string",
   *  every member an object type -> "reference", anything else (any, unknown,
   *  a number, a mixed union, a type parameter) -> undefined. */
  /** Is the declared type of `e` made of references only: object types (class
   *  instances, arrays, functions, object literals) and null/undefined, with no
   *  primitive, any, unknown, type parameter or intersection member? An
   *  identifier answers for its declaration's type and a property access for
   *  the property's, not the flow-narrowed type at this site, because the
   *  local that holds a variable serves all its sites. */
  declaredReferenceOnly(e: ts.Expression): boolean {
    let t: ts.Type | undefined;
    try {
      let inner: ts.Expression = e;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (ts.isIdentifier(inner) || (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name))) {
        const sym = this.checker.getSymbolAtLocation(ts.isIdentifier(inner) ? inner : inner.name);
        const target = sym && (sym.flags & ts.SymbolFlags.Alias) ? this.checker.getAliasedSymbol(sym) : sym;
        if (!target) return false;
        const anyChecker = this.checker as unknown as { getTypeOfSymbol?: (s: ts.Symbol) => ts.Type };
        t = anyChecker.getTypeOfSymbol ? anyChecker.getTypeOfSymbol(target)
          : (target.valueDeclaration ? this.checker.getTypeOfSymbolAtLocation(target, target.valueDeclaration) : undefined);
      } else {
        t = this.checker.getTypeAtLocation(inner);
      }
    } catch { return false; }
    if (!t) return false;
    const F = ts.TypeFlags;
    if (this.typeHasAnyOrUnknown(t)) return false;
    const members = (t.flags & F.Union) ? (t as ts.UnionType).types : [t];
    let live = 0;
    for (const m of members) {
      if (m.flags & (F.Undefined | F.Null | F.Void)) continue;
      if (!(m.flags & F.Object)) return false;
      live++;
    }
    return live > 0;
  }
  /** Mark a local as holding references only (docs/ref_eq_design.md). */
  markReferenceLocal(ctx: FnCtx, local: number): void {
    const l = ctx.locals[local] as { tyKind?: "string" | "reference" };
    if (l && l.tyKind === undefined) l.tyKind = "reference";
  }
  keyKindOfExpr(expr: ts.Expression): "string" | "reference" | undefined {
    let t: ts.Type;
    try { t = this.checker.getTypeAtLocation(expr); } catch { return undefined; }
    const F = ts.TypeFlags;
    if (this.typeHasAnyOrUnknown(t)) return undefined;
    const members = (t.flags & F.Union) ? (t as ts.UnionType).types : [t];
    const live = members.filter((m) => !(m.flags & (F.Undefined | F.Null | F.Void)));
    if (live.length === 0) return undefined;
    if (live.every((m) => (m.flags & F.StringLike) !== 0)) return "string";
    if (live.every((m) => (m.flags & F.Object) !== 0)) return "reference";
    return undefined;
  }

  typeSpecOfExpr(expr: ts.Expression): TypeSpec | undefined {
    try {
      return this.typeSpecForType(this.checker.getTypeAtLocation(expr));
    } catch {
      return undefined;
    }
  }

  inLoop(node: ts.Node | undefined): boolean {
    let p = node?.parent;
    while (p && !isFunctionLike(p)) {
      if (
        ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) ||
        ts.isWhileStatement(p) || ts.isDoStatement(p)
      ) return true;
      p = p.parent;
    }
    return false;
  }
  // True if `node` is lexically inside the try-block or catch-clause of an
  // enclosing try/finally (within the current function). A multi-level labeled
  // break/continue from here would cross/sit-within that finally; the structured
  // finally path only models a single enclosing loop, so we reject those (the
  // common multi-level case — nested loops without finally — is unaffected).
  insideTryWithFinally(node: ts.Node): boolean {
    let child: ts.Node = node;
    let p: ts.Node | undefined = node.parent;
    while (p && !isFunctionLike(p)) {
      if (ts.isTryStatement(p) && p.finallyBlock &&
          (child === p.tryBlock || (p.catchClause !== undefined && child === p.catchClause))) {
        return true;
      }
      child = p;
      p = p.parent;
    }
    return false;
  }
  determinableObject(node: ts.Node): boolean {
    try {
      const t = this.checker.getTypeAtLocation(node);
      if (t.flags & ts.TypeFlags.Any) return false;
      if (!(t.flags & ts.TypeFlags.Object)) return false;
      if (this.checker.getIndexInfosOfType(t).length > 0) return false; // open/indexable
      return true;
    } catch {
      return false;
    }
  }
  recordSite(site: number, kind: string, mult: "once" | "many", det: boolean, node?: ts.Node, synthetic = false) {
    this.siteMeta.push({ site, multiplicity: mult, layoutDeterminable: det, kind });
    // Use the node's OWN source file (the bundler lowers nodes from many files);
    // synthetic nodes may lack a position, so guard.
    let nsf: ts.SourceFile | undefined;
    try { nsf = node?.getSourceFile(); } catch { nsf = undefined; }
    if (node && nsf) {
      const start = node.getStart(nsf);
      const end = node.getEnd();
      const s = nsf.getLineAndCharacterOfPosition(start);
      const e = nsf.getLineAndCharacterOfPosition(end);
      let text = nsf.text.slice(start, end).replace(/\s+/g, " ");
      if (text.length > 48) text = text.slice(0, 45) + "...";
      this.siteSpans.push({
        site, kind, synthetic,
        line: s.line + 1, col: s.character + 1,
        endLine: e.line + 1, endCol: e.character + 1,
        text,
      });
    }
  }

  newLocal(ctx: FnCtx, refKind: RefKind, name?: string, binding?: number): number {
    const id = ctx.locals.length;
    const safeName = name !== undefined && hasUnpairedSurrogate(name) ? undefined : name;
    ctx.locals.push({ id, typeId: 0, refKind, name: safeName, binding });
    return id;
  }
  ensureLocal(ctx: FnCtx, sym: ts.Symbol, refKind: RefKind, name?: string): number {
    const existing = ctx.localOfSymbol.get(sym);
    if (existing !== undefined) { (ctx.storageLocals ??= new Set()).add(existing); return existing; }
    const id = this.newLocal(ctx, refKind, name);
    ctx.localOfSymbol.set(sym, id);
    (ctx.storageLocals ??= new Set()).add(id);
    return id;
  }
  isScriptGlobalVarSymbol(sym: ts.Symbol | undefined, name?: string): boolean {
    if (this.sourceMode !== "script") return false;
    if (sym && this.scriptGlobalVarSyms.has(sym)) return true;
    return !!name && this.scriptGlobalVarNames.has(name) && this.isAmbientGlobalSymbol(sym);
  }
  /** `this` where no thisLocal is bound. SCRIPT top level (the __module_init
   *  body) sees the GLOBAL OBJECT — V8 classic-script semantics (vm-verified:
   *  `this === globalThis`, property writes land on globalThis, top-level
   *  arrows inherit it lexically). Module top level and plain strict function
   *  bodies stay undefined (the local's TS_UNDEFINED default). Sloppy
   *  CALL-time this (bare `f()` seeing globalThis) is intentionally NOT
   *  modeled — semantics stay always-strict; this covers only the top-level
   *  lexical `this`. */
  lowerUnboundThis(ctx: FnCtx): number {
    const dst = this.newLocal(ctx, "reference", "this");
    if (this.sourceMode === "script" && ctx.id === this.moduleInitId) {
      ctx.body.push({ kind: "LoadBuiltinFn", dst, builtin: "globalThis" });
    }
    return dst;
  }
  isLexicalTdzUse(node: ts.Identifier, sym: ts.Symbol | undefined): boolean {
    if (!sym || this.isAmbientGlobalSymbol(sym)) return false;
    const decl = (sym.valueDeclaration ?? sym.declarations?.[0]) as ts.Node | undefined;
    if (!decl || decl.getSourceFile() !== node.getSourceFile()) return false;
    let lexical = false;
    if (ts.isVariableDeclaration(decl)) {
      const list = decl.parent;
      lexical = !!(list && ts.isVariableDeclarationList(list) &&
        ((list.flags & ts.NodeFlags.Let) || (list.flags & ts.NodeFlags.Const)));
    } else if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) {
      lexical = true;
    }
    if (!lexical) return false;
    if (this.enclosingFunction(node) !== this.enclosingFunction(decl)) return false;

    // node and decl are in the SAME file (guarded above), so use that file's
    // positions — not this.sf, which during bundling is just the entry module.
    const sf = node.getSourceFile();
    const usePos = node.getStart(sf);
    const declPos = decl.getStart(sf);
    if (usePos < declPos) return true;

    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let insideInit = false;
      const visit = (n: ts.Node) => {
        if (insideInit) return;
        if (n === node) { insideInit = true; return; }
        if (isFunctionLike(n) && n !== decl.initializer) return;
        ts.forEachChild(n, visit);
      };
      visit(decl.initializer);
      if (insideInit) return true;
    }
    return false;
  }
  /** Loud-reject a cross-module TDZ hazard that `isLexicalTdzUse` (single-file,
   *  positional) cannot see: a module in an import cycle reading another cycle
   *  member's lexical binding (const/let/class) at module-init (top-level) scope.
   *  In real ESM this throws a TDZ ReferenceError when the read runs before the
   *  binding's initializer; the bundler's scope-hoisting would silently read the
   *  not-yet-assigned local (silent miscompile). Conservative: only top-level
   *  reads in cyclic modules of cross-module lexicals are rejected — function-
   *  deferred access (the common, safe cyclic pattern) and hoisted functions/var
   *  are untouched. */
  isCyclicCrossModuleTdzUse(node: ts.Identifier, sym: ts.Symbol | undefined): boolean {
    if (this.cyclicModules.size === 0) return false;
    const canonical = this.unwrapImportAlias(sym) ?? sym;
    if (!canonical || this.isAmbientGlobalSymbol(canonical)) return false;
    const decl = (canonical.valueDeclaration ?? canonical.declarations?.[0]) as ts.Node | undefined;
    if (!decl) return false;
    let lexical = false;
    if (ts.isVariableDeclaration(decl)) {
      const list = decl.parent;
      lexical = !!(list && ts.isVariableDeclarationList(list) &&
        ((list.flags & ts.NodeFlags.Let) || (list.flags & ts.NodeFlags.Const)));
    } else if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) {
      lexical = true;
    }
    if (!lexical) return false;
    const declSf = decl.getSourceFile();
    const useSf = node.getSourceFile();
    if (declSf === useSf) return false; // same module: positional check handles it
    // Only module-init (top-level) reads are hazardous; deferred reads inside a
    // function run after both modules finished initializing.
    if (this.enclosingFunction(node) !== undefined || this.inInstanceFieldInitializer(node)) return false;
    const declarationOrder = this.moduleInitializationOrder.get(declSf);
    const useOrder = this.moduleInitializationOrder.get(useSf);
    // A completed dependency has initialized its lexical declarations even when
    // both files belong to the same import cycle.
    if (declarationOrder !== undefined && useOrder !== undefined && declarationOrder < useOrder) return false;
    return this.cyclicModules.has(useSf) && this.cyclicModules.has(declSf);
  }
  /** The build-time constant an identifier names (TSAOT_DEFINE), when the name is an ambient
   *  declaration (`declare var __DEV__: boolean`) and not a binding of the program. */
  defineValueOf(id: ts.Identifier, sym: ts.Symbol | undefined): boolean | number | string | undefined {
    if (this.defines.size === 0) return undefined;
    const v = this.defines.get(id.text);
    if (v === undefined || !this.isAmbientGlobalSymbol(sym)) return undefined;
    return v;
  }
  defineConst(ctx: FnCtx, id: ts.Identifier, v: boolean | number | string): number {
    const dst = this.newLocal(ctx, typeof v === "string" ? "reference" : "primitive", id.text);
    const value = typeof v === "boolean" ? { kind: "Bool", value: v }
      : typeof v === "number" ? (Object.is(v, -0) ? { kind: "NegZero" } : Number.isNaN(v) ? { kind: "NaN" } : { kind: "Num", value: this.numWire(v) })
      : { kind: "Str", value: v };
    ctx.body.push({ kind: "Const", dst, value } as any);
    return dst;
  }
  /** The value of a condition the build-time constants decide (`__DEV__`, `!__BROWSER__`,
   *  `__DEV__ && x`, `__BROWSER__ || x`, parentheses, `true`/`false`); undefined when it depends on
   *  a run-time value. The `&&`/`||` cases fold only as JS short-circuits them. */
  constCondValue(node: ts.Expression): boolean | undefined {
    if (this.defines.size === 0) return undefined;
    let e: ts.Expression = node;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(e)) {
      const v = this.defineValueOf(e, this.symbolOf(e));
      if (v === undefined) return undefined;
      return typeof v === "boolean" ? v : typeof v === "number" ? (v !== 0 && !Number.isNaN(v)) : v !== "";
    }
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const v = this.constCondValue(e.operand);
      return v === undefined ? undefined : !v;
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken) {
        const l = this.constCondValue(e.left);
        return l === false ? false : l === true ? this.constCondValue(e.right) : undefined;
      }
      if (k === ts.SyntaxKind.BarBarToken) {
        const l = this.constCondValue(e.left);
        return l === true ? true : l === false ? this.constCondValue(e.right) : undefined;
      }
    }
    return undefined;
  }
  /** `node` is in the initializer of an instance field: code that runs at construction, after every
   *  module finished initializing, like a function body (a static field's initializer runs with the
   *  class definition). */
  inInstanceFieldInitializer(node: ts.Node): boolean {
    let child: ts.Node = node;
    let p: ts.Node | undefined = node.parent;
    while (p && !ts.isSourceFile(p)) {
      if (ts.isPropertyDeclaration(p)) {
        return p.initializer === child &&
          !(ts.canHaveModifiers(p) && (ts.getModifiers(p) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword));
      }
      child = p;
      p = p.parent;
    }
    return false;
  }
  /** The environment's value an identifier names (an ambient declaration): the
   *  global object's property, a ReferenceError when it is not there, except as
   *  the operand of `typeof`. */
  loadEnvironmentValue(ctx: FnCtx, id: ts.Identifier): number {
    let e: ts.Node = id;
    while (ts.isParenthesizedExpression(e.parent)) e = e.parent;
    if (ts.isTypeOfExpression(e.parent)) return this.loadGlobalObjectProperty(ctx, id.text);
    const dst = this.newLocal(ctx, "reference", id.text);
    ctx.body.push({ kind: "LoadBuiltinFn", dst, builtin: `globalref.${id.text}` });
    return dst;
  }
  loadGlobalObjectProperty(ctx: FnCtx, name: string): number {
    const dst = this.newLocal(ctx, "reference", name);
    ctx.body.push({ kind: "LoadBuiltinFn", dst, builtin: `globalobj.${name}` });
    return dst;
  }
  storeGlobalObjectProperty(ctx: FnCtx, name: string, src: number): void {
    const obj = this.newLocal(ctx, "reference", "globalThis");
    ctx.body.push({ kind: "LoadBuiltinFn", dst: obj, builtin: "globalThis" });
    ctx.body.push({ kind: "StoreField", obj, field: this.internField(name), src });
  }
  declareGlobalVarProperty(ctx: FnCtx, name: string): void {
    ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
      builtin: `global.varDecl:${name}`, args: [] });
  }
  unwrapExpr(node: ts.Expression): ts.Expression {
    let e = node;
    for (;;) {
      if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) ||
          ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) {
        e = e.expression;
        continue;
      }
      const isSatisfies = (ts as any).isSatisfiesExpression;
      if (typeof isSatisfies === "function" && isSatisfies(e)) {
        e = (e as any).expression;
        continue;
      }
      return e;
    }
  }
  staticPropertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    const arg = this.unwrapExpr(node.argumentExpression);
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isNumericLiteral(arg)) {
      return arg.text;
    }
    if (ts.isIdentifier(arg)) return this.stringConstValues.get(arg.text);
    return undefined;
  }
  isGlobalThisPropertyAccess(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, name: string): boolean {
    const basePath = this.globalObjectMutationPath(node.expression);
    return basePath !== undefined && basePath.length === 0 && this.staticPropertyName(node) === name;
  }
  globalObjectMutationPath(node: ts.Expression): string[] | undefined {
    const e = this.unwrapExpr(node);
    if (ts.isIdentifier(e)) {
      const aliasPath = this.globalObjectAliasPaths.get(e.text);
      if (aliasPath !== undefined) return aliasPath;
      if (e.text === "globalThis" && this.isAmbientGlobalSymbol(this.symbolOf(e))) return [];
      const gname = this.globalObjectValueName(e.text);
      if (gname !== undefined && this.isAmbientGlobalSymbol(this.symbolOf(e))) return [gname];
      return undefined;
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const basePath = this.globalObjectMutationPath(e.expression);
      if (basePath === undefined) return undefined;
      const name = this.staticPropertyName(e);
      if (name === undefined) return undefined;
      return [...basePath, name];
    }
    return undefined;
  }
  recordGlobalMutationPath(path: string[] | undefined): void {
    if (!path || path.length === 0) return;
    const root = path[0];
    if (this.globalObjectValueName(root) === undefined) return;
    if (path.length === 1) {
      this.mutatedGlobalNames.add(root);
      return;
    }
    this.mutatedGlobalMembers.add(`${root}.${path[1]}`);
  }
  recordGlobalMutationTarget(target: ts.Expression): void {
    const e = this.unwrapExpr(target);
    if (ts.isIdentifier(e)) {
      this.recordIdentifierGlobalMutation(e);
      return;
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const basePath = this.globalObjectMutationPath(e.expression);
      if (basePath !== undefined && this.staticPropertyName(e) === undefined) {
        return;
      }
    }
    this.recordGlobalMutationPath(this.globalObjectMutationPath(e));
  }
  recordIdentifierGlobalMutation(id: ts.Identifier): void {
    const gname = this.globalObjectValueName(id.text);
    if (gname === undefined) return;
    const sym = this.symbolOf(id);
    if (this.isAmbientGlobalSymbol(sym) || this.isScriptGlobalVarSymbol(sym, id.text)) {
      this.mutatedGlobalNames.add(gname);
    }
  }
  collectMutatedGlobalRefs(sf: ts.SourceFile): void {
    const markWriteTarget = (target: ts.Expression) => {
      this.recordGlobalMutationTarget(target);
    };
    const stringArg = (expr: ts.Expression | undefined): string | undefined => {
      if (!expr) return undefined;
      const e = this.unwrapExpr(expr);
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
      if (ts.isIdentifier(e)) return this.stringConstValues.get(e.text);
      return undefined;
    };
    const propName = (name: ts.PropertyName): string | undefined => {
      if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ||
          ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
      if (ts.isComputedPropertyName(name)) return stringArg(name.expression);
      return undefined;
    };
    const objectLiteralKeys = (expr: ts.Expression): string[] | undefined => {
      const e = this.unwrapExpr(expr);
      if (!ts.isObjectLiteralExpression(e)) return undefined;
      const keys: string[] = [];
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) return undefined;
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ||
            ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
          const name = propName(p.name);
          if (name === undefined) return undefined;
          keys.push(name);
        }
      }
      return keys;
    };
    const markLiteralObjectKeys = (target: string[] | undefined, source: ts.Expression): void => {
      if (target === undefined) return;
      const keys = objectLiteralKeys(source);
      if (keys === undefined) {
        return;
      }
      for (const key of keys) this.recordGlobalMutationPath([...target, key]);
    };
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
          this.sourceMode === "script" && this.declaredAtModuleScope(n)) {
        const sym = this.symbolOf(n.name);
        if (this.isScriptGlobalVarSymbol(sym, n.name.text) && this.globalObjectValueName(n.name.text) !== undefined) {
          this.mutatedGlobalNames.add(n.name.text);
        }
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = this.unwrapExpr(n.initializer);
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          this.stringConstValues.set(n.name.text, init.text);
        }
        const path = this.globalObjectMutationPath(n.initializer);
        if (path !== undefined) this.globalObjectAliasPaths.set(n.name.text, path);
      }
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        if (k === ts.SyntaxKind.EqualsToken && ts.isIdentifier(this.unwrapExpr(n.left))) {
          const lhs = this.unwrapExpr(n.left) as ts.Identifier;
          const rhs = this.unwrapExpr(n.right);
          if (ts.isStringLiteral(rhs) || ts.isNoSubstitutionTemplateLiteral(rhs)) {
            this.stringConstValues.set(lhs.text, rhs.text);
          }
          const path = this.globalObjectMutationPath(n.right);
          if (path !== undefined) this.globalObjectAliasPaths.set(lhs.text, path);
        }
        if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
          markWriteTarget(n.left);
        }
      }
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
          (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
        markWriteTarget(n.operand);
      }
      if (ts.isDeleteExpression(n)) markWriteTarget(n.expression);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
          n.arguments.length >= 2 && n.expression.name.text === "defineProperty" &&
          ts.isIdentifier(n.expression.expression) && this.isBuiltinNamespaceRef(n.expression.expression, "Object")) {
        const base = this.globalObjectMutationPath(n.arguments[0]);
        const prop = stringArg(n.arguments[1]);
        if (base !== undefined && prop !== undefined) this.recordGlobalMutationPath([...base, prop]);
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
          n.arguments.length >= 2 && n.expression.name.text === "defineProperties" &&
          ts.isIdentifier(n.expression.expression) && this.isBuiltinNamespaceRef(n.expression.expression, "Object")) {
        const base = this.globalObjectMutationPath(n.arguments[0]);
        markLiteralObjectKeys(base, n.arguments[1]);
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
          n.arguments.length >= 2 && n.expression.name.text === "assign" &&
          ts.isIdentifier(n.expression.expression) && this.isBuiltinNamespaceRef(n.expression.expression, "Object")) {
        const base = this.globalObjectMutationPath(n.arguments[0]);
        for (let i = 1; i < n.arguments.length; i++) markLiteralObjectKeys(base, n.arguments[i]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  globalNameMaybeMutated(name: string): boolean {
    return this.mutatedGlobalNames.has(name);
  }
  globalMemberMaybeMutated(ns: string, member: string): boolean {
    return this.mutatedGlobalNames.has(ns) || this.mutatedGlobalMembers.has(`${ns}.${member}`);
  }
  private lowerSpreadArguments(ctx: FnCtx, args: readonly ts.Expression[]): { kind: string; local: number }[] {
    return args.map(arg => {
      const spread = ts.isSpreadElement(arg);
      const expression = spread ? arg.expression : arg;
      let local = this.lowerExpr(ctx, expression);
      if (spread) {
        // Consume each iterator now. Later argument expressions can mutate the
        // original array or iterator; the argument list retains the old values.
        const site = this.site++;
        this.recordSite(site, "array", this.inLoop(arg) ? "many" : "once", false, arg);
        const snapshot = this.newLocal(ctx, "reference", "spreadArgs");
        ctx.body.push({ kind: "AllocArray", dst: snapshot, elemType: 0, site });
        ctx.body.push({ kind: "ArrayPushAll", arr: snapshot, src: local });
        local = snapshot;
      } else if (this.isMutableStorageLocal(ctx, local)) {
        const snapshot = this.newLocal(ctx, this.refKindOf(expression));
        ctx.body.push({ kind: "Copy", dst: snapshot, src: local });
        local = snapshot;
      }
      return { kind: spread ? "spread" : "single", local };
    });
  }
  lowerDynamicValueCall(ctx: FnCtx, calleeLocal: number, recv: number | undefined,
                        argExprs: readonly ts.Expression[], resultKind: RefKind): number {
    const hasSpread = argExprs.some((a) => ts.isSpreadElement(a));
    if (hasSpread) {
      if (this.isMutableStorageLocal(ctx, calleeLocal)) {
        const snapshot = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Copy", dst: snapshot, src: calleeLocal });
        calleeLocal = snapshot;
      }
      const argSpecs = this.lowerSpreadArguments(ctx, argExprs);
      const dst = this.newLocal(ctx, resultKind);
      const inst: any = { kind: "CallSpread", dst, callee: { kind: "Value", local: calleeLocal }, argSpecs };
      if (recv !== undefined) inst.recv = recv;
      ctx.body.push(inst);
      return dst;
    }
    const args = this.lowerSequenced(ctx, argExprs);
    const dst = this.newLocal(ctx, resultKind);
    const inst: any = { kind: "Call", dst, callee: { kind: "Value", local: calleeLocal }, args };
    if (recv !== undefined) inst.recv = recv;
    ctx.body.push(inst);
    return dst;
  }
  lowerGlobalIdentifierDynamicCall(ctx: FnCtx, name: string, argExprs: readonly ts.Expression[], resultKind: RefKind): number {
    const calleeLocal = this.loadGlobalObjectProperty(ctx, name);
    return this.lowerDynamicValueCall(ctx, calleeLocal, undefined, argExprs, resultKind);
  }
  lowerGlobalMemberDynamicCall(ctx: FnCtx, ns: string, member: string,
                               argExprs: readonly ts.Expression[], resultKind: RefKind): number {
    const recv = this.loadGlobalObjectProperty(ctx, ns);
    const calleeLocal = this.newLocal(ctx, "reference", `${ns}.${member}`);
    ctx.body.push({ kind: "LoadField", dst: calleeLocal, obj: recv, field: this.internField(member) });
    return this.lowerDynamicValueCall(ctx, calleeLocal, recv, argExprs, resultKind);
  }

  /** Conservative: does evaluating `node` possibly mutate a variable (so an
   *  already-read bare-variable operand could change before it's consumed)? */
  mayHaveSideEffect(node: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
          (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) { found = true; return; }
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) { found = true; return; }
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n) ||
          ts.isAwaitExpression(n) || ts.isYieldExpression(n) || ts.isDeleteExpression(n)) { found = true; return; }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  }

  stripTransparentExpr(e: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    return e;
  }

  isStringConcatManyOperand(e: ts.Expression): boolean {
    e = this.stripTransparentExpr(e);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) return true;
    if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword ||
        e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.UndefinedKeyword) return true;
    if (ts.isIdentifier(e) && e.text === "undefined") return true;
    if (!ts.isIdentifier(e)) return false;
    try {
      const t = this.checker.getTypeAtLocation(e);
      const F = ts.TypeFlags;
      return (t.flags & (F.StringLike | F.NumberLike | F.BooleanLike | F.Void | F.Undefined | F.Null)) !== 0;
    } catch {
      return false;
    }
  }

  isStringLikeExpr(e: ts.Expression): boolean {
    e = this.stripTransparentExpr(e);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
    try {
      const t = this.checker.getTypeAtLocation(e);
      return (t.flags & ts.TypeFlags.StringLike) !== 0;
    } catch {
      return false;
    }
  }

  flattenStringConcatMany(node: ts.BinaryExpression): ts.Expression[] | undefined {
    const parts: ts.Expression[] = [];
    const walk = (e: ts.Expression): boolean => {
      e = this.stripTransparentExpr(e);
      // Only flatten a '+' that is itself a STRING concatenation. A numeric '+'
      // subtree (e.g. the `(i + 1)` in `s + (i + 1)`) evaluates to one number and
      // must stay a single operand — splicing its operands into the concat list
      // would turn the numeric addition into string concatenation (`s + i + 1`).
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        this.isStringLikeExpr(e)
      ) {
        return walk(e.left) && walk(e.right);
      }
      if (!this.isStringConcatManyOperand(e)) return false;
      parts.push(e);
      return true;
    };
    if (!walk(node) || parts.length < 3) return undefined;
    if (!this.isStringLikeExpr(parts[0]) && !this.isStringLikeExpr(parts[1])) return undefined;
    try {
      const t = this.checker.getTypeAtLocation(node);
      if ((t.flags & ts.TypeFlags.StringLike) === 0) return undefined;
    } catch {
      return undefined;
    }
    return parts;
  }

  /** A canonical variable-slot local — a bare read of it aliases a slot that an
   *  in-place write (`=`/`++`) may later overwrite within the same expression. */
  isMutableStorageLocal(ctx: FnCtx, id: number): boolean {
    return ctx.storageLocals?.has(id) ?? false;
  }

  /** Lower a left-to-right operand list with JS sequence-point semantics: if an
   *  operand reads a canonical variable slot AND a LATER sibling may mutate it,
   *  snapshot that operand into a fresh local (Copy) so its value is fixed at its
   *  evaluation point. (Only aliasing bare-variable reads need this; every other
   *  expression already lands its value in a fresh local at its own instruction.) */
  lowerSequenced(ctx: FnCtx, exprs: readonly ts.Expression[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < exprs.length; i++) {
      let v = this.lowerExpr(ctx, exprs[i]);
      if (this.isMutableStorageLocal(ctx, v)) {
        let laterSfx = false;
        for (let j = i + 1; j < exprs.length; j++) { if (this.mayHaveSideEffect(exprs[j])) { laterSfx = true; break; } }
        if (laterSfx) {
          const s = this.newLocal(ctx, this.refKindOf(exprs[i]));
          ctx.body.push({ kind: "Copy", dst: s, src: v });
          v = s;
        }
      }
      out.push(v);
    }
    return out;
  }

  // --------------------- pre-pass: ids, module vars ---------------------------
  /** Bundler symbol linking: resolve an import-binding ALIAS symbol to the
   *  canonical EXPORT symbol it refers to (following re-export chains), so a
   *  reference to an imported name keys on the SAME ts.Symbol as the exporting
   *  module's declaration — the basis for cross-module resolution. No-op for
   *  non-alias symbols (single-file programs have no value-import aliases). */
  private unwrapImportAlias(sym: ts.Symbol | undefined): ts.Symbol | undefined {
    // A type-only import merged with a local VALUE declaration of the same name
    // (`import { SourceMapSource }` + `let SourceMapSource` in nodeFactory.ts,
    // `function SourceMapSource` in utilities.ts) carries Alias plus a value
    // flag. Its value meaning is the local declaration, so keep that symbol:
    // unwrapping to the alias target (the interface) keyed every module's local
    // of that name to one symbol and conflated the two bindings.
    if (sym && (sym.flags & ts.SymbolFlags.Alias) && !(sym.flags & ts.SymbolFlags.Value)) {
      try { const t = this.checker.getAliasedSymbol(sym); if (t) return t; } catch { /* keep original */ }
    }
    return sym;
  }
  symbolOf(node: ts.Node | undefined): ts.Symbol | undefined {
    if (!node) return undefined;
    // A parameter property's name (`constructor(private x)`) resolves to the
    // class's PROPERTY symbol; the constructor body's `x` is the PARAMETER.
    // Bind and capture the parameter, which the body reads.
    if (ts.isIdentifier(node) && node.parent && ts.isParameter(node.parent) && node.parent.name === node &&
        ts.isParameterPropertyDeclaration(node.parent, node.parent.parent)) {
      const symbols = this.checker.getSymbolsOfParameterPropertyDeclaration(node.parent, node.text);
      if (symbols.length > 0) return symbols[0];
    }
    const applyTopLevelFallback = (sym: ts.Symbol | undefined): ts.Symbol | undefined => {
      let a = this.unwrapImportAlias(sym);
      // Checking a named function expression can replace its reference symbol
      // with a transient type symbol. Both denote the same lexical self binding;
      // keep capture maps keyed by the declaration's original binding symbol.
      const declaration = a?.valueDeclaration;
      if (a && (a.flags & ts.SymbolFlags.Transient) && declaration &&
          ts.isFunctionExpression(declaration) && declaration.name) {
        a = (declaration as unknown as { symbol?: ts.Symbol }).symbol ?? a;
      }
      if (ts.isIdentifier(node) && this.isVarRef(node) && this.isAmbientGlobalSymbol(a)) {
        // A module's top-level binding is in scope in its own file only; another
        // file reaches it through an import, which the checker resolves. A
        // same-named binding elsewhere (a module exporting `JSON`) must not
        // capture this file's reference to the global.
        const top = this.moduleTopBindingByName.get(node.text);
        if (top === undefined) return a;
        const declSf = top.declarations?.[0]?.getSourceFile();
        let useSf: ts.Node | undefined = node;
        while (useSf && !ts.isSourceFile(useSf)) useSf = useSf.parent;
        return declSf === undefined || useSf === undefined || declSf === useSf ? top : a;
      }
      return a;
    };
    // A shorthand property's name (`{a}`) resolves via getSymbolAtLocation to the
    // PROPERTY symbol, not the referenced binding. For var-reference semantics
    // (free-variable/capture analysis, owner resolution, and lowering) we want the
    // value binding `a`, so redirect to the shorthand's value symbol centrally —
    // this keeps capture analysis and lowerIdentifier consistent.
    if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
      return applyTopLevelFallback(this.checker.getShorthandAssignmentValueSymbol(node.parent) ?? this.checker.getSymbolAtLocation(node));
    }
    return applyTopLevelFallback(this.checker.getSymbolAtLocation(node));
  }
  // Step A (scope_resolution.md §3): symbol-based built-in classification.
  // A name is a global built-in (Math, console, Array, fetch, ...) iff its
  // symbol's declarations are ALL in ambient declaration files (`*.d.ts` —
  // this covers TypeScript's stdlib `lib.*.d.ts` AND `@types/*` augmentations
  // such as `@types/node/.../fetch.d.ts` and `console`). If ANY declaration is
  // in a user-source file (a non-`.d.ts` .ts/.tsx/.mts/.cts), the name is a
  // user binding (possibly shadowing a global), so this returns false and the
  // reference resolves as an ordinary binding — fixing the silent miscompile
  // where `const Math = {sqrt:()=>-1}; Math.sqrt(4)` wrongly dispatched to the
  // real Math.
  //
  // Note: a `.d.ts` declaration is ambient by definition; user code does not
  // declare runtime values in `.d.ts`. So "all decls are .d.ts" precisely
  // characterizes ambient/built-in names.
  // Step F: true if a class member has the `static` modifier. ClassElement
  // doesn't expose `.modifiers` directly in this TS version; use the modifiers
  // API guarded by canHaveModifiers.
  isStaticMember(m: ts.ClassElement): boolean {
    if (!ts.canHaveModifiers(m)) return false;
    const mods = ts.getModifiers(m);
    return !!mods?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword);
  }
  isBuiltinSymbol(sym: ts.Symbol | undefined): boolean {
    if (!sym) return false;
    let s = sym;
    // Follow aliases (e.g. imported names) to the original symbol.
    if (s.flags & ts.SymbolFlags.Alias) {
      try { s = this.checker.getAliasedSymbol(s); } catch { /* keep s */ }
    }
    const decls = s.declarations;
    if (!decls || decls.length === 0) return false;
    for (const d of decls) {
      const fn = d.getSourceFile().fileName;
      if (!fn.endsWith(".d.ts")) return false; // a user-source declaration => not a builtin
    }
    return true;
  }
  /** A symbol declared in lib/node's own files (the library's ambient primitives). */
  isLibNodeSymbol(sym: ts.Symbol | undefined): boolean {
    if (!sym || nodeLibDir === undefined) return false;
    const dir = nodeLibDir;
    return !!sym.declarations && sym.declarations.length > 0 && sym.declarations.every((d) => d.getSourceFile().fileName.startsWith(dir));
  }
  isAmbientGlobalSymbol(sym: ts.Symbol | undefined): boolean {
    if (!sym) return true;
    let s = sym;
    if (s.flags & ts.SymbolFlags.Alias) {
      try { s = this.checker.getAliasedSymbol(s); } catch { /* keep s */ }
    }
    if (!s.declarations || s.declarations.length === 0) return true;
    return this.isBuiltinSymbol(s);
  }
  // True if `expr` is a reference to a built-in namespace identifier `name`
  // (Math/Number/Object/JSON/String/Array/console/Symbol/Date/...), using
  // symbol resolution rather than bare text. Falls back to text-equality only
  // when the identifier has no symbol at all (defensive; shouldn't happen for
  // a resolvable program).
  isBuiltinNamespaceRef(expr: ts.Expression, name: string): boolean {
    if (!ts.isIdentifier(expr) || expr.text !== name) return false;
    const sym = this.symbolOf(expr);
    if (!sym) return true;            // no symbol: treat as the ambient global
    return this.isAmbientGlobalSymbol(sym); // shadowed user binding => false
  }
  isKnownBuiltinNamespaceRef(expr: ts.Expression): boolean {
    if (!ts.isIdentifier(expr)) return false;
    const namespaces = new Set(["Math", "Number", "Object", "JSON", "String", "Array", "console", "Symbol", "Date", "Promise", "Reflect"]);
    return namespaces.has(expr.text) && this.isBuiltinNamespaceRef(expr, expr.text);
  }
  /** Evaluate a fully-constant NUMERIC expression in native JS (exact JS semantics,
   *  including -0 / NaN / ±Infinity), or undefined if it isn't a numeric constant.
   *  A non-constant leaf (variable / call / etc.) yields undefined, so the caller
   *  never folds away a side effect. Used to fold -0-producing constant arithmetic. */
  constNumValue(node: ts.Expression): number | undefined {
    let n: ts.Expression = node;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (ts.isPrefixUnaryExpression(n)) {
      const v = this.constNumValue(n.operand);
      if (v === undefined) return undefined;
      switch (n.operator) {
        case ts.SyntaxKind.MinusToken: return -v;
        case ts.SyntaxKind.PlusToken: return +v;
        case ts.SyntaxKind.TildeToken: return ~v;
        default: return undefined;
      }
    }
    if (ts.isBinaryExpression(n)) {
      const a = this.constNumValue(n.left); if (a === undefined) return undefined;
      const b = this.constNumValue(n.right); if (b === undefined) return undefined;
      switch (n.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return a + b;
        case ts.SyntaxKind.MinusToken: return a - b;
        case ts.SyntaxKind.AsteriskToken: return a * b;
        case ts.SyntaxKind.SlashToken: return a / b;
        case ts.SyntaxKind.PercentToken: return a % b;
        case ts.SyntaxKind.AsteriskAsteriskToken: return a ** b;
        case ts.SyntaxKind.AmpersandToken: return a & b;
        case ts.SyntaxKind.BarToken: return a | b;
        case ts.SyntaxKind.CaretToken: return a ^ b;
        case ts.SyntaxKind.LessThanLessThanToken: return a << b;
        case ts.SyntaxKind.GreaterThanGreaterThanToken: return a >> b;
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return a >>> b;
        default: return undefined;
      }
    }
    return undefined;
  }

  /** Fold a side-effect-free template substitution to its exact JS string.
   *
   *  This is deliberately narrower than general constant folding: every accepted
   *  form is a primitive literal or a numeric expression handled by
   *  constNumValue(), so folding cannot suppress user code or observable
   *  ToPrimitive/ToString calls. Numeric results are stringified by the exporter
   *  host (V8), including -0 -> "0" and NaN/Infinity spellings. */
  constTemplateString(node: ts.Expression): string | undefined {
    const n = this.stripTransparentExpr(node);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (n.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (n.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (n.kind === ts.SyntaxKind.NullKeyword) return "null";
    if (ts.isIdentifier(n) && n.text === "undefined" &&
        this.isAmbientGlobalSymbol(this.symbolOf(n))) return "undefined";
    const num = this.constNumValue(n);
    return num === undefined ? undefined : String(num);
  }

  constJsonNumberValue(node: ts.Expression): { value: number; usedJson: boolean } | undefined {
    let n: ts.Expression = node;
    while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    if (ts.isNumericLiteral(n)) return { value: Number(n.text), usedJson: false };
    if (ts.isPrefixUnaryExpression(n)) {
      const v = this.constJsonNumberValue(n.operand);
      if (v === undefined) return undefined;
      switch (n.operator) {
        case ts.SyntaxKind.MinusToken: return { value: -v.value, usedJson: v.usedJson };
        case ts.SyntaxKind.PlusToken: return { value: +v.value, usedJson: v.usedJson };
        case ts.SyntaxKind.TildeToken: return { value: ~v.value, usedJson: v.usedJson };
        default: return undefined;
      }
    }
    if (ts.isBinaryExpression(n)) {
      const a = this.constJsonNumberValue(n.left); if (a === undefined) return undefined;
      const b = this.constJsonNumberValue(n.right); if (b === undefined) return undefined;
      const usedJson = a.usedJson || b.usedJson;
      switch (n.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return { value: a.value + b.value, usedJson };
        case ts.SyntaxKind.MinusToken: return { value: a.value - b.value, usedJson };
        case ts.SyntaxKind.AsteriskToken: return { value: a.value * b.value, usedJson };
        case ts.SyntaxKind.SlashToken: return { value: a.value / b.value, usedJson };
        case ts.SyntaxKind.PercentToken: return { value: a.value % b.value, usedJson };
        case ts.SyntaxKind.AsteriskAsteriskToken: return { value: a.value ** b.value, usedJson };
        case ts.SyntaxKind.AmpersandToken: return { value: a.value & b.value, usedJson };
        case ts.SyntaxKind.BarToken: return { value: a.value | b.value, usedJson };
        case ts.SyntaxKind.CaretToken: return { value: a.value ^ b.value, usedJson };
        case ts.SyntaxKind.LessThanLessThanToken: return { value: a.value << b.value, usedJson };
        case ts.SyntaxKind.GreaterThanGreaterThanToken: return { value: a.value >> b.value, usedJson };
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return { value: a.value >>> b.value, usedJson };
        default: return undefined;
      }
    }
    if (ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "parse" &&
        this.isBuiltinNamespaceRef(n.expression.expression, "JSON") &&
        n.arguments.length === 1) {
      const text = n.arguments[0];
      if (ts.isStringLiteral(text) || ts.isNoSubstitutionTemplateLiteral(text)) {
        try {
          const parsed = JSON.parse(text.text);
          if (typeof parsed === "number" && Number.isFinite(parsed)) return { value: parsed, usedJson: true };
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  /** Matches the property-access chain `Object.prototype.toString` (not a call).
   *  Used to special-case `Object.prototype.toString.call(x)` — the spec tag idiom. */
  isObjectProtoToString(e: ts.Expression): boolean {
    return this.objectProtoMethodName(e) === "toString";
  }
  /** `Object.prototype.hasOwnProperty` itself, or a `const` bound to it
   *  (`const hasOwnProperty = Object.prototype.hasOwnProperty;`). */
  isObjectProtoHasOwnValue(e: ts.Expression): boolean {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (this.objectProtoMethodName(e) === "hasOwnProperty") return true;
    if (!ts.isIdentifier(e)) return false;
    const sym = this.symbolOf(e);
    const d = sym?.valueDeclaration;
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return false;
    const list = d.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return false;
    let init: ts.Expression = d.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    return this.objectProtoMethodName(init) === "hasOwnProperty";
  }
  /** If `e` is the chain `Object.prototype.<m>` for a method we model as a
   *  first-class value, return that name; else undefined. Backs the `objproto.*`
   *  builtin function values (so `const f = Object.prototype.toString; f.call(x)`
   *  and `.hasOwnProperty.call(o,k)` work as values, with `this` = the .call/.apply
   *  receiver). */
  objectProtoMethodName(e: ts.Expression): "toString" | "toLocaleString" | "hasOwnProperty" | "isPrototypeOf" | "propertyIsEnumerable" | "valueOf" | undefined {
    if (!ts.isPropertyAccessExpression(e)) return undefined;
    const m = e.name.text;
    if (m !== "toString" && m !== "toLocaleString" && m !== "hasOwnProperty" &&
        m !== "isPrototypeOf" && m !== "propertyIsEnumerable" && m !== "valueOf") return undefined;
    const p = e.expression;                              // expect `Object.prototype`
    if (!ts.isPropertyAccessExpression(p) || p.name.text !== "prototype") return undefined;
    if (ts.isIdentifier(p.expression) && this.isBuiltinNamespaceRef(p.expression, "Object")) return m;
    return undefined;
  }
  /** If `e` is `<Builtin>.prototype.<method>` for a builtin whose prototype methods
   *  we represent (Array/String/Map/Set/Number) and `method` is one of them, return
   *  its receiver kind + method name; else undefined. Backs `protoobj.<kind>` proto
   *  object values, so `Array.prototype.slice.call(arr, i)` / `const m =
   *  Array.prototype.map; typeof m` work as first-class values (the boxed proto
   *  method is read off the runtime prototype via LoadMethodValue). Shadowing by a
   *  local `const Array = ...` is rejected by isBuiltinNamespaceRef. */
  builtinProtoMethod(e: ts.Expression): { kind: "object" | "string" | "array" | "map" | "set" | "weakmap" | "weakset" | "headers" | "number" | "boolean" | "function"; method: string } | undefined {
    if (!ts.isPropertyAccessExpression(e)) return undefined;
    const method = e.name.text;
    const p = e.expression;                              // expect `<Builtin>.prototype`
    if (!ts.isPropertyAccessExpression(p) || p.name.text !== "prototype") return undefined;
    const ns = p.expression;
    if (!ts.isIdentifier(ns)) return undefined;
    // Function.prototype.{call,apply,bind} as a value (method-borrow / uncurry-this):
    // gated by a literal set since builtinMethodName2 has no "function" kind.
    if (this.isBuiltinNamespaceRef(ns, "Function") && (method === "call" || method === "apply" || method === "bind")) {
      return { kind: "function", method };
    }
    const kinds: [string, "string" | "array" | "map" | "set" | "weakmap" | "weakset" | "headers" | "number" | "boolean"][] =
      [["Array", "array"], ["String", "string"], ["Map", "map"], ["Set", "set"],
       ["WeakMap", "weakmap"], ["WeakSet", "weakset"],
       ["Number", "number"], ["Boolean", "boolean"]];
    for (const [name, kind] of kinds) {
      if (this.isBuiltinNamespaceRef(ns, name) && this.builtinMethodName2(kind, method) !== undefined) {
        return { kind, method };
      }
    }
    return undefined;
  }

  /** A BARE `<Builtin>.prototype` used as a first-class value (no trailing method),
   *  e.g. `const p = Array.prototype`. Returns the runtime proto-object kind, or
   *  undefined. Object.prototype is handled by the §81/§89 object-proto paths.
   *  `Function.prototype` is a callable no-op (typeof "function") — the runtime
   *  g_function_proto is a real ts_func, so it loads like the others. The proto
   *  object is loaded via LoadBuiltinFn {protoobj.<kind>} (the §90 mechanism), which
   *  already returns the proto object itself — the bare form just omits the trailing
   *  LoadMethodValue. */
  bareBuiltinProtoKind(e: ts.Expression): "object" | "string" | "array" | "map" | "set" | "weakmap" | "weakset" | "headers" | "number" | "boolean" | "function" | undefined {
    if (!ts.isPropertyAccessExpression(e) || e.name.text !== "prototype") return undefined;
    const ns = e.expression;
    if (!ts.isIdentifier(ns)) return undefined;
    const kinds: [string, "object" | "string" | "array" | "map" | "set" | "weakmap" | "weakset" | "headers" | "number" | "boolean" | "function"][] =
      [["Object", "object"], ["Array", "array"], ["String", "string"], ["Map", "map"],
       ["Set", "set"], ["WeakMap", "weakmap"], ["WeakSet", "weakset"],
       ["Number", "number"], ["Boolean", "boolean"],
       ["Function", "function"]];
    for (const [name, kind] of kinds) {
      if (this.isBuiltinNamespaceRef(ns, name)) return kind;
    }
    return undefined;
  }
  enclosingFunction(node: ts.Node | undefined): ts.Node | undefined {
    let p = node?.parent;
    while (p) {
      if (isFunctionLike(p)) return p;
      if (ts.isSourceFile(p)) return undefined;
      p = p.parent;
    }
    return undefined;
  }
  symbolOwnerFunction(s: ts.Symbol): ts.Node | undefined {
    const d = s.valueDeclaration ?? s.declarations?.[0];
    const enc = d ? this.enclosingFunction(d) : undefined;
    // Step C: a module-scope binding (declared directly under the SourceFile)
    // is conceptually owned by the synthetic __module_init. Returning that node
    // lets the free-var/cell machinery treat nested-function references to it
    // as captures (cells), so top-level `function f(){ return moduleVar; }`
    // observes the value rather than reading an empty local.
    // A module-scope binding OR a value-namespace member (tsaot lowers namespace
    // bodies inline into __module_init, so their bindings live there too). Both are
    // recorded in moduleScopeSyms, which is the authority; `enc === undefined`
    // confirms there is no enclosing real function.
    if (enc === undefined && this.moduleInitNode && this.moduleScopeSyms.has(s)) {
      return this.moduleInitNode;
    }
    return enc;
  }
  // True if a VariableDeclaration is part of a top-level VariableStatement.
  declaredAtModuleScope(d: ts.VariableDeclaration): boolean {
    const list = d.parent;                 // VariableDeclarationList
    const stmt = list?.parent;             // VariableStatement
    return !!stmt && ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent);
  }

  assignIds(sf: ts.SourceFile) {
    const walk = (n: ts.Node) => {
      // Object-literal method-shorthand `{ greet() {} }` (MethodDeclaration) and
      // accessor members `{ get x(){}, set x(v){} }` (Get/SetAccessorDeclaration)
      // are lifted like function expressions (this = object). isLiftable() excludes
      // these, so id them here. (Includes the defineProperty descriptor case
      // `{ get() {} }`, which is a MethodDeclaration named "get".)
      if ((ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) &&
          n.body && n.parent && ts.isObjectLiteralExpression(n.parent) &&
          n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ||
                     (ts.isComputedPropertyName(n.name) && this.isSymbolKeyExpr(n.name.expression)))) {
        if (!this.fnId.has(n)) this.fnId.set(n, this.fnId.size);
      }
      // Dynamic/symbol-keyed computed class METHOD (`class C { [k](){}, [sym](){},
      // *[sym](){}, async [k](){} }`) is installed at runtime as a data-property
      // closure (emitFieldInitializers / lowerStaticInit), so it needs an fnId like
      // an object-literal method. Plain/generator/async methods all qualify;
      // accessors with such keys take the separate isDynComputedInstallAccessor path.
      if (this.isDynComputedInstallMethod(n)) {
        if (!this.fnId.has(n)) this.fnId.set(n, this.fnId.size);
      }
      // Dynamic/symbol-keyed computed INSTANCE accessor (`get [sym]()`/`set [sym]()`)
      // is installed as a real accessor descriptor in emitFieldInitializers, so it
      // also needs an fnId. (Static dynamic/symbol accessors get theirs in
      // setupClasses' static routing.)
      if (this.isDynComputedInstallAccessor(n)) {
        if (!this.fnId.has(n)) this.fnId.set(n, this.fnId.size);
      }
      if (isLiftable(n) && (!ts.isFunctionDeclaration(n) || n.body)) {
        if (!this.fnId.has(n)) this.fnId.set(n, this.fnId.size);
        const nestedDecl = ts.isFunctionDeclaration(n) && n.name && !ts.isSourceFile(n.parent) &&
          this.nestedDirect && this.enclosingFunction(n) !== undefined;
        const nsDecl = !nestedDecl && ts.isFunctionDeclaration(n) && n.name &&
          this.namespaceDirect && this.isValueNamespaceMember(n);
        if (ts.isFunctionDeclaration(n) && n.name && (ts.isSourceFile(n.parent) || nestedDecl || nsDecl)) {
          const s = this.symbolOf(n.name);
          if (s) this.funcSymbols.set(s, this.fnId.get(n)!);
          if (s && nestedDecl) this.nestedFuncSymbols.add(s);
          if (s && nsDecl) this.namespaceFuncSymbols.add(s);
          // record explicit `this` parameter — or an ES5 body reading its own
          // `this` (same args[0] slot) — so direct calls prepend a this slot.
          if ((n.parameters.length > 0 && ts.isIdentifier(n.parameters[0].name) &&
              n.parameters[0].name.text === "this") || this.fnUsesOwnThis(n)) {
            this.funcTakesThisIds.add(this.fnId.get(n)!);
          }
        }
      }
      n.forEachChild(walk);
    };
    walk(sf);
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt) && !(stmt.flags & AMBIENT_NODE_FLAG)) {
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            const s = this.symbolOf(d.name);
            if (s) this.moduleVars.add(s);
            if (s && isConst && d.initializer && process.env.TSAOT_CONST_FN_DIRECT !== "0") {
              const init = this.unwrapExpr(d.initializer);
              const fid = this.fnId.get(init);
              if (fid !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
                  !init.asteriskToken && !(ts.getCombinedModifierFlags(init) & ts.ModifierFlags.Async) &&
                  !(ts.isFunctionExpression(init) && init.name) &&
                  !(ts.isArrowFunction(init) ? this.arrowUsesThis(init) : this.fnUsesOwnThis(init)) &&
                  !(init.body && this.bodyUsesArguments(init.body))) {
                // its only possible capture is the module's scope record (a module-level binding lives
                // there), which the direct call threads as it does for a function declaration; the
                // free variables are not computed here (the capture analysis runs later, and its
                // cache must not see an early answer)
                this.constFnSymbols.set(s, fid);
              }
            }
            if (s && isConst && d.initializer && process.env.TSAOT_BUILTIN_ALIAS !== "0") {
              // `const isArray = Array.isArray`, `const extend = Object.assign` (vue's shared helpers,
              // lodash's `nativeKeys = Object.keys`): a call through the binding is the builtin's static
              // call, as `NS.member(args)` lowers; `const hasOwnProperty = Object.prototype.hasOwnProperty`
              // and `objectToString = Object.prototype.toString` make `m.call(x, ...)` the runtime's
              // implementation. A namespace member the program may have reassigned keeps the value call.
              const init = this.unwrapExpr(d.initializer);
              if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression) && ts.isIdentifier(init.name) &&
                  ["Math", "Number", "Object", "Array", "String", "Date", "Reflect"].includes(init.expression.text) &&
                  this.isBuiltinNamespaceRef(init.expression, init.expression.text) &&
                  !this.globalMemberMaybeMutated(init.expression.text, init.name.text)) {
                this.constBuiltinAliases.set(s, { ns: init.expression.text, member: init.name.text });
              } else if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.name) &&
                  (init.name.text === "hasOwnProperty" || init.name.text === "toString") &&
                  ts.isPropertyAccessExpression(init.expression) && ts.isIdentifier(init.expression.expression) &&
                  init.expression.name.text === "prototype" && this.isBuiltinNamespaceRef(init.expression.expression, "Object") &&
                  !this.globalMemberMaybeMutated("Object", "prototype")) {
                this.constProtoMethodAliases.set(s, init.name.text);
              }
            }
          }
        }
      }
    }
  }

  // --------------------------- capture analysis -------------------------------
  isVarRef(id: ts.Identifier): boolean {
    const p = id.parent;
    if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
    if (ts.isQualifiedName(p) && p.right === id) return false;
    if (ts.isPropertyAssignment(p) && p.name === id) return false;
    if (ts.isPropertySignature(p) && p.name === id) return false;
    if (ts.isVariableDeclaration(p) && p.name === id) return false;
    if (ts.isParameter(p) && p.name === id) return false;
    if (ts.isFunctionDeclaration(p) && p.name === id) return false;
    if ((ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === id) return false;
    if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
    return true;
  }
  declaredIn(F: FnLike): Set<ts.Symbol> {
    const cached = this.declaredCache.get(F);
    if (cached) return cached;
    const decl = new Set<ts.Symbol>();
    const bind = (name: ts.BindingName) => {
      if (ts.isIdentifier(name)) {
        const s = this.symbolOf(name);
        if (s) decl.add(s);
      } else {
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) bind(element.name);
        }
      }
    };
    for (const p of F.parameters) bind(p.name);
    const visitOwn = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n)) bind(n.name);
      const nsName = this.namespaceBindingName(n);
      if (nsName) {
        const sym = this.symbolOf(nsName);
        if (sym) decl.add(sym);
      }
      if (this.isValueDefaultExport(n)) {
        const sym = this.defaultExportSymbolOf(n);
        if (sym) decl.add(sym);
      }
      if (ts.isFunctionDeclaration(n) && n.name) {
        const s = this.symbolOf(n.name);
        if (s) decl.add(s);
      }
      if (ts.isClassDeclaration(n) && n.name) {
        const s = this.symbolOf(n.name);
        if (s) decl.add(s);
      }
      if (ts.isEnumDeclaration(n)) {
        const s = this.symbolOf(n.name);
        if (s) decl.add(s);
      }
      if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) {
        // a value namespace binds its name in F's scope (like an enum); its body
        // is a separate scope handled by lowerModuleDeclaration.
        const s = this.symbolOf(n.name);
        if (s) decl.add(s);
      }
      n.forEachChild((c) => {
        // A nested function declaration is itself DECLARED in F (its name binds
        // in F's scope), so record its name, but do NOT descend into its body
        // (that's a separate scope). Other function-likes (expressions, arrows)
        // don't bind a name in F, so just skip them.
        if (ts.isFunctionDeclaration(c) && c.name) {
          const s = this.symbolOf(c.name);
          if (s) decl.add(s);
          return;
        }
        if (ts.isClassDeclaration(c) && c.name) {
          const s = this.symbolOf(c.name);
          if (s) decl.add(s);
          return;
        }
        if (ts.isEnumDeclaration(c)) {
          // An enum binds its name in F's scope; its body is a separate scope.
          const s = this.symbolOf(c.name);
          if (s) decl.add(s);
          return;
        }
        if (ts.isModuleDeclaration(c) && ts.isIdentifier(c.name)) {
          // A value namespace binds its name in F's scope. tsaot lowers the body
          // INLINE (no IIFE function), so its members live in F's frame too —
          // descend so captured private members (e.g. a const referenced by an
          // exported function closure) get their cells allocated here.
          const s = this.symbolOf(c.name);
          if (s) decl.add(s);
          if (c.body && ts.isModuleBlock(c.body)) for (const st of c.body.statements) visitOwn(st);
          return;
        }
        if (!isFunctionLike(c)) visitOwn(c);
      });
    };
    if (F.body) visitOwn(F.body);
    this.declaredCache.set(F, decl);
    return decl;
  }
  collectNested(n: ts.Node, out: FnLike[]) {
    n.forEachChild((c) => {
      if (isLiftable(c)) out.push(c);
      else if (isObjLitFn(c)) out.push(c as unknown as FnLike); // obj-literal method/accessor: captures like an arrow
      else if (isFunctionLike(c)) {
        /* class method/ctor boundary: skip body for MVP */
      } else this.collectNested(c, out);
    });
  }
  /** Free variables of F, transitively including the module cells needed by the
   *  top-level functions F (directly or indirectly) calls. Call GRAPHS can be
   *  cyclic (emitBody -> emitInst -> emitTryCatch -> emitBody in real programs),
   *  so this iterates one-round computations to a FIXPOINT: an in-progress node
   *  on a cycle reads the previous round's value (not a permanently-cached empty
   *  seed — that under-approximated mid-cycle members, so a caller threaded
   *  fewer module cells than its callee's params expected = silent garbage). */
  freeVars(F: FnLike): Set<ts.Symbol> {
    const cached = this.freeCache.get(F);
    if (cached) return cached;
    let prev = new Map<ts.Node, Set<ts.Symbol>>();
    for (;;) {
      this.freePass = new Map();
      this.freePrev = prev;
      this.freeInProgress.clear();
      this.freeVarsInner(F);
      // Monotone: inputs only grow round over round, so size-compare suffices.
      let grew = false;
      for (const [k, v] of this.freePass) {
        const p = prev.get(k);
        if (!p || p.size !== v.size) { grew = true; break; }
      }
      prev = this.freePass;
      if (!grew) break;
    }
    // Converged: finalize every node computed in the region (their sets depend
    // only on this reachable region, so they are correct for future queries).
    for (const [k, v] of prev) this.freeCache.set(k, v);
    if (process.env.TSAOT_DEBUG_FREEVARS) {
      for (const [k, v] of prev) {
        const txt = k.pos >= 0 ? k.getText().slice(0, 50).replace(/\n/g, " ") : "<module init>";
        console.error(`[free] ${txt} => [${[...v].map((s) => (s as { name?: string }).name ?? "?").join(",")}]`);
      }
    }
    return this.freeCache.get(F)!;
  }

  /** One fixpoint round: finalized nodes come from freeCache, nodes already
   *  computed this round from freePass, in-progress (cycle) nodes from the
   *  PREVIOUS round (freePrev). */
  freeVarsInner(F: FnLike): Set<ts.Symbol> {
    const done = this.freeCache.get(F);
    if (done) return done;
    const thisRound = this.freePass.get(F);
    if (thisRound) return thisRound;
    if (this.freeInProgress.has(F)) return this.freePrev.get(F) ?? new Set();
    this.freeInProgress.add(F);
    const decl = this.declaredIn(F);
    const res = new Set<ts.Symbol>();
    const calledFns: FnLike[] = [];
    const nested: FnLike[] = [];
    const ctorRefs: ts.ConstructorDeclaration[] = []; // ctors Direct-called from F (new/super)
    /** A value reference to the binding `s` (named `name`; `isCallee` when it is a call's callee). */
    const noteRef = (s: ts.Symbol | undefined, name: string, isCallee: boolean): void => {
      if (!s) return;
      if (this.isScriptGlobalVarSymbol(s, name) || this.isAmbientValueSymbol(s)) {
        // Script top-level var bindings and the environment's values are
        // runtime global-object properties, not closure cells. Reads/writes
        // lower to globalThis.<name>.
        return;
      }
      if (decl.has(s)) return;
      if (this.funcSymbols.has(s) && !((this.nestedFuncSymbols.has(s) || this.namespaceFuncSymbols.has(s)) && !isCallee)) return;
      const owner = this.symbolOwnerFunction(s);
      if (owner && owner !== F) res.add(s); // captured from an outer function (incl. __module_init)
      // Lazy closure values: the user of a nested declaration's value may
      // have to create the closure, so it captures what the declaration
      // captures (the direct-call rule, below, applied to value uses).
      if (this.lazyFnValues && this.nestedFuncSymbols.has(s) && !isCallee) {
        const fnode = this.fnNodeById(this.funcSymbols.get(s)!);
        if (fnode && fnode !== (F as unknown as ts.Node)) calledFns.push(fnode as unknown as FnLike);
      }
    };
    const scan = (n: ts.Node) => {
      // Type annotations have no runtime reads. Treating a local interface,
      // type parameter, or callback signature as a value invents capture cells.
      // A class's extends expression still executes, including generic bases.
      if (ts.isExpressionWithTypeArguments(n)) {
        const clause = n.parent;
        if (ts.isHeritageClause(clause) && clause.token === ts.SyntaxKind.ExtendsKeyword &&
            (ts.isClassDeclaration(clause.parent) || ts.isClassExpression(clause.parent)))
          scan(n.expression);
        return;
      }
      if (ts.isTypeNode(n) || ts.isTypeParameterDeclaration(n) ||
          ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
      if (ts.isIdentifier(n) && this.isVarRef(n)) {
        const symbol = this.symbolOf(n);
        const binding = symbol && this.namespaceBindings.get(symbol);
        const s = binding ? this.symbolOf(binding.namespace) : symbol;
        noteRef(s, n.text, ts.isCallExpression(n.parent) && n.parent.expression === n);
      }
      // JSX: an element calls the runtime's `jsx` / `jsxs` (or the classic factory) and a fragment reads
      // `Fragment` (or the fragment factory), bindings the source never names: a bundled function is a
      // direct call (its cells roll up as a call's), a value is a reference to its binding.
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
        const site = this.jsxSiteCallees(n);
        for (const [callee, isCall] of [[site.call, true], [site.value, false]] as const) {
          if (!callee) continue;
          if (isCall && callee.fn !== undefined && !this.funcTakesThisIds.has(callee.fn)) {
            const fnode = this.fnNodeById(callee.fn);
            if (fnode && fnode !== (F as unknown as ts.Node)) calledFns.push(fnode as unknown as FnLike);
          } else if (callee.name && !callee.ns) {
            noteRef(this.symbolOf(callee.name), callee.name.text, isCall);
          }
        }
      }
      // `new C()` / `super(...)`: F Direct-calls that ctor and must thread its
      // FUNCTION-LOCAL capture cells (emitCtorCall), so F transitively captures
      // them. (Module-scope ones travel via GLOBALS, so they're not rolled up.)
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
        const cs = this.symbolOf(n.expression);
        const cid = cs ? this.classSymToId.get(cs) : undefined;
        const cn = cid !== undefined ? this.ctorNodeOfClassId(cid) : undefined;
        if (cn && (cn as unknown as ts.Node) !== (F as unknown as ts.Node)) ctorRefs.push(cn);
      }
      // `super.m` whose static resolution does not stand (a dynamic class on
      // the path, docs/conformance_fixes.md "super calls through a dynamic
      // parent"): the body reads its own class value to reach the home
      // object's prototype, so it captures the class binding. A module-scope
      // class travels through GLOBALS like any binding a method captures; a
      // function-local class keeps the static resolution.
      if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) {
        const csym = this.superHomeClassSymbol(n);
        if (csym && this.moduleScopeSyms.has(csym) && !decl.has(csym)) {
          const cid = this.classSymToId.get(csym);
          const pid = cid !== undefined ? this.parentIdOf(cid) : undefined;
          if (pid !== undefined && this.superPathIsDynamic(pid, n.name.text)) {
            const owner = this.symbolOwnerFunction(csym);
            if (owner && owner !== F) res.add(csym);
          }
        }
      }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) {
        const cn = this.parentCtorNodeOf(F);
        if (cn && (cn as unknown as ts.Node) !== (F as unknown as ts.Node)) ctorRefs.push(cn);
      }
      // Record direct calls to top-level functions: a function f that calls g
      // must receive every module cell g needs (g reads it via a threaded cell
      // param), even if f never names the variable itself. This is transitive
      // capture over the call graph, required because top-level functions are
      // siblings (not lexically nested), so the nested-propagation below does
      // not see them. Only module-cell symbols propagate this way.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const cs = this.symbolOf(n.expression);
        if (cs && this.funcSymbols.has(cs)) {
          const fnode = this.fnNodeById(this.funcSymbols.get(cs)!);
          if (fnode && fnode !== (F as unknown as ts.Node)) calledFns.push(fnode as unknown as FnLike);
        }
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        // `N.f(...)` on a value namespace is a direct call to the member (see
        // namespaceMemberCallTarget): the caller must hold the cells it needs.
        const target = this.namespaceMemberCallTarget(n.expression);
        if (target !== undefined) {
          const fnode = this.fnNodeById(target.fnId);
          if (fnode && fnode !== (F as unknown as ts.Node)) calledFns.push(fnode as unknown as FnLike);
        }
      }
      n.forEachChild((c) => {
        if (!isFunctionLike(c)) scan(c);
      });
    };
    // Scan an expression/body subtree that may ITSELF be a function-like node:
    // a function-valued node is a NESTING BOUNDARY (its captures roll up via the
    // nested-freeVars rollup below) — scanning into it would count its own
    // params/locals as F's captures (e.g. the inner `b` of an arrow chain
    // `(a) => (b) => f(a, b)`, whose body IS the inner arrow). scan()/
    // collectNested() guard function-like CHILDREN but not the root node.
    const scanExpr = (e: ts.Node) => {
      if (isLiftable(e) || isObjLitFn(e)) { nested.push(e as unknown as FnLike); return; }
      if (isFunctionLike(e)) return; // class-member boundary: skip body (as collectNested does)
      scan(e);
      this.collectNested(e, nested);
    };
    if (F.body) scanExpr(F.body);
    // Also scan PARAMETER patterns: a default value or a computed destructuring
    // key (`function f({[k]: v} = d)`) can reference an enclosing-scope variable
    // that must be captured. (Param NAMES are in declaredIn, so they're skipped.)
    const scanParamPart = scanExpr;
    const scanPat = (name: ts.BindingName) => {
      if (ts.isObjectBindingPattern(name)) {
        for (const el of name.elements) {
          if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) scanParamPart(el.propertyName.expression);
          if (el.initializer) scanParamPart(el.initializer);
          if (!ts.isIdentifier(el.name)) scanPat(el.name);
        }
      } else if (ts.isArrayBindingPattern(name)) {
        for (const el of name.elements) {
          if (ts.isBindingElement(el)) {
            if (el.initializer) scanParamPart(el.initializer);
            if (!ts.isIdentifier(el.name)) scanPat(el.name);
          }
        }
      }
    };
    for (const p of F.parameters) {
      if (p.initializer) scanParamPart(p.initializer);
      scanPat(p.name);
    }
    // A constructor also runs the class's instance field initializers and installs
    // its dynamic/symbol computed members (emitFieldInitializers); those
    // expressions are lowered INTO the ctor body, so the bindings they capture are
    // the ctor's free vars too. (Without this the ctor never receives the cell and
    // a `field = outerLocal` / `[k]` read garbage.) Function-local captures then
    // become threaded cell params; module-scope ones are filtered to GLOBALS later.
    if (ts.isConstructorDeclaration(F as unknown as ts.Node)) {
      const cls = (F as unknown as ts.Node).parent;
      if (cls && (ts.isClassDeclaration(cls) || ts.isClassExpression(cls))) {
        for (const m of cls.members) {
          if (this.isStaticMember(m)) continue;
          if (ts.isPropertyDeclaration(m) && m.initializer) scanExpr(m.initializer);
          const nm = (m as { name?: ts.PropertyName }).name;
          if (nm && ts.isComputedPropertyName(nm) && this.isDynComputedMember(m)) scanExpr(nm.expression);
          if (this.isDynComputedInstallMethod(m) || this.isDynComputedInstallAccessor(m)) nested.push(m as unknown as FnLike); // its body captures roll up
        }
      }
    }
    for (const g of nested) {
      for (const s of this.freeVarsInner(g)) {
        // A named function expression creates its own lexical self binding at
        // the closure site; the enclosing function does not capture that name.
        if (ts.isFunctionExpression(g) && g.name && this.symbolOf(g.name) === s) continue;
        if (!decl.has(s)) res.add(s);
      }
    }
    // Transitive: pull in the cells needed by directly called functions. For a
    // top-level callee only module-scope symbols (owned by __module_init) can
    // be free; a NESTED callee's free variables are its enclosing functions'
    // locals, which the caller must hold too (it supplies the scope records).
    // A called function's own locals/params are not our concern.
    for (const g of calledFns) {
      const nestedCallee = !ts.isSourceFile((g as unknown as ts.Node).parent);
      for (const s of this.freeVarsInner(g)) {
        if (this.isScriptGlobalVarSymbol(s) || decl.has(s)) continue;
        if (this.moduleScopeSyms.has(s)) { res.add(s); continue; }
        if (nestedCallee){
          const owner = this.symbolOwnerFunction(s);
          if (owner && owner !== F) res.add(s);
        }
      }
    }
    // Transitive capture through `new C()` / `super(...)`: F threads the called
    // ctor's FUNCTION-LOCAL cells, so F must itself hold them (unless F declares
    // them). Module-scope ones go via GLOBALS and are not threaded here.
    for (const cn of ctorRefs) {
      for (const s of this.freeVarsInner(cn as unknown as FnLike)) {
        if (!this.isScriptGlobalVarSymbol(s) && !decl.has(s) && !this.moduleScopeSyms.has(s)) res.add(s);
      }
    }
    this.freeInProgress.delete(F);
    this.freePass.set(F, res);
    return res;
  }

  /** The constructor declaration (with a body) of class `classId`, or undefined. */
  ctorNodeOfClassId(classId: number): ts.ConstructorDeclaration | undefined {
    const cn = this.classNodeOfId.get(classId);
    if (!cn) return undefined;
    for (const m of cn.members) if (ts.isConstructorDeclaration(m) && m.body) return m;
    return undefined;
  }

  /** The parent class's constructor (with a body) for a constructor node `F`, or
   *  undefined (no parent, or parent has no explicit ctor). */
  /** The class whose member body a `super` reference belongs to: the nearest
   *  enclosing method, accessor or constructor through arrow functions (which
   *  inherit `super`); undefined for any other function boundary. */
  superHomeClassSymbol(n: ts.Node): ts.Symbol | undefined {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isArrowFunction(p)) continue;
      if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isConstructorDeclaration(p)) {
        const cls = p.parent;
        if ((ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name) return this.symbolOf(cls.name);
        return undefined;
      }
      if (ts.isFunctionLike(p) || ts.isClassLike(p)) return undefined;
    }
    return undefined;
  }
  parentCtorNodeOf(F: FnLike): ts.ConstructorDeclaration | undefined {
    const cls = (F as unknown as ts.Node).parent;
    if (!cls || !(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) || !cls.name) return undefined;
    const csym = this.symbolOf(cls.name);
    const cid = csym ? this.classSymToId.get(csym) : undefined;
    const pid = cid !== undefined ? this.parentIdOf(cid) : undefined;
    return pid !== undefined ? this.ctorNodeOfClassId(pid) : undefined;
  }
  sortedFreeVars(F: FnLike): ts.Symbol[] {
    const arr = [...this.freeVars(F)];
    for (const s of arr) this.bindingIdOf(s); // ensure ids assigned
    arr.sort((a, b) => this.bindingIdOf(a) - this.bindingIdOf(b));
    return arr;
  }

  // Step C: reverse map fnId -> node (built lazily). Used to discover a Direct
  // callee's captured cells so the caller can thread them as leading args.
  _fnNodeById: Map<number, ts.Node> | undefined;
  fnNodeById(id: number): ts.Node | undefined {
    if (!this._fnNodeById) {
      this._fnNodeById = new Map();
      for (const [node, fid] of this.fnId) this._fnNodeById.set(fid, node);
    }
    return this._fnNodeById.get(id);
  }
  /** A specialized clone shares its declaration node with the original: register
   *  the clone id so direct calls thread the declaration's captured cells. */
  registerSpecNode(specId: number, node: ts.Node): void {
    this.fnNodeById(-1);
    this._fnNodeById!.set(specId, node);
  }
  // ---------------- capture contexts (C5b-1) ----------------
  /** A captured binding lives in its owner's scope record unless it needs its
   *  own cell: a binding declared inside a loop (fresh per iteration), the
   *  lexical-this sentinel, or the self binding of a named function expression. */
  /** Every binding some assignment targets (`=`, compound, `++`/`--`, a
   *  destructuring assignment, `for (x of …)` with an existing variable) and
   *  every `let`/`var` declared without an initializer. Declaration
   *  initializers do not count. */
  private computeAssignedBindings(): void {
    // Each assignment is recorded as the node whose COMPLETION gives the
    // binding its value (the whole assignment expression, update expression,
    // loop statement or declaration), so a closure created inside the
    // right-hand side (`cycle = p.then(() => cycle)`) counts as created before
    // the assignment.
    const mark = (id: ts.Identifier, at: ts.Node) => {
      const sym = this.symbolOf(id);
      if (!sym) return;
      this.assignedSyms.add(sym);
      let arr = this.assignmentSites.get(sym);
      if (!arr) { arr = []; this.assignmentSites.set(sym, arr); }
      arr.push(at);
    };
    const target = (e: ts.Expression, at: ts.Node) => {
      if (ts.isIdentifier(e)) { mark(e, at); return; }
      if (ts.isParenthesizedExpression(e)) { target(e.expression, at); return; }
      if (ts.isArrayLiteralExpression(e)) { for (const el of e.elements) target(el, at); return; }
      if (ts.isObjectLiteralExpression(e)) {
        for (const prop of e.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) mark(prop.name, at);
          else if (ts.isPropertyAssignment(prop)) target(prop.initializer, at);
          else if (ts.isSpreadAssignment(prop)) target(prop.expression, at);
        }
        return;
      }
      if (ts.isSpreadElement(e)) { target(e.expression, at); return; }
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) { target(e.left, at); return; }
      if (ts.isOmittedExpression(e)) return;
      // property/element targets assign a property, not a binding
    };
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target(n.left, n);
      else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
               (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) target(n.operand, n);
      else if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) target(n.initializer, n);
      else if (ts.isVariableDeclaration(n) && !n.initializer && ts.isIdentifier(n.name) &&
               !(n.parent && ts.isVariableDeclarationList(n.parent) && (ts.isForOfStatement(n.parent.parent) || ts.isForInStatement(n.parent.parent)))) mark(n.name, n);
      ts.forEachChild(n, visit);
    };
    for (const m of this.modules) visit(m);
  }
  /** May `s` travel by value (docs/value_captures_design.md)? Never assigned,
   *  owned by a real function, a plain parameter or an initialized
   *  `const`/`let`, and — unless a parameter — captured only by closures created
   *  after its declaration (expression closures textually after it, and nested
   *  declarations that are only ever called directly). */
  /** The innermost loop statement enclosing both nodes, below `owner`. */
  private innermostCommonLoop(a: ts.Node, b: ts.Node, owner: ts.Node): ts.Node | undefined {
    const loopsOf = (n: ts.Node): ts.Node[] => {
      const out: ts.Node[] = [];
      for (let p: ts.Node | undefined = n.parent; p && p !== owner; p = p.parent) if (isLoopStatement(p)) out.push(p);
      return out;
    };
    const la = new Set(loopsOf(a));
    for (const l of loopsOf(b)) if (la.has(l)) return l;
    return undefined;
  }
  private valueCapturable(s: ts.Symbol): boolean {
    if (!this.valueCaptures || s === this.lexicalThisSym) return false;
    if (this.cellOnlySyms.has(s)) return false;
    if (this.funcSymbols.has(s) || this.classSymToId.has(s) || this.namespaceBindings.has(s)) return false;
    if (this.moduleScopeSyms.has(s) || this.isScriptGlobalVarSymbol(s)) return false;
    const d = s.valueDeclaration ?? s.declarations?.[0];
    if (!d || (s.declarations?.length ?? 0) !== 1) return false;
    const owner = this.symbolOwnerFunction(s);
    if (!owner || owner === this.moduleInitNode || owner === this.functionValuesInitNode) return false;
    let isParam = false;
    if (ts.isParameter(d)) {
      if (!ts.isIdentifier(d.name) || d.dotDotDotToken) return false;
      if (!(d.parent as ts.Node) || (d.parent as ts.Node) !== owner) return false;
      isParam = true;
    } else if (ts.isVariableDeclaration(d)) {
      if (!ts.isIdentifier(d.name)) return false;
      const list = d.parent;
      if (!ts.isVariableDeclarationList(list) || (list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) return false;
      if (!d.initializer && !this.assignedSyms.has(s)) return false;
    } else {
      return false;
    }
    const captures = this.capturedByFns.get(s) ?? [];
    if (!isParam) {
      for (const f of captures) {
        const fn = f as unknown as ts.Node;
        if (ts.isFunctionDeclaration(fn)) {
          const fsym = fn.name ? this.symbolOf(fn.name) : undefined;
          if (!this.lazyFnDecls || !fsym || this.fnValueUsed.has(fsym)) return false; // hoisted as a value
          continue;
        }
        if (fn.pos < d.end) return false; // created before the declaration completes
      }
    }
    if (this.assignedSyms.has(s)) {
      // Settled before capture (docs/value_captures_design.md, round 2): every
      // assignment precedes every capturing closure's creation in the text, the
      // capturing functions are expression closures (a declaration is created
      // or called at times the text does not fix), and no loop encloses both
      // an assignment and a capture unless it also encloses the declaration
      // (a per-iteration binding). A closure that writes the binding fails the
      // text test by itself: the assignment lies inside it.
      const sites = this.assignmentSites.get(s) ?? [];
      for (const f of captures) {
        const fn = f as unknown as ts.Node;
        if (ts.isFunctionDeclaration(fn)) return false;
        for (const a of sites) {
          if (a.end > fn.pos) return false;   // the closure starts before the assignment completes
          const loop = this.innermostCommonLoop(a, fn, owner);
          if (loop && !(ts.isVariableDeclaration(d) && d.pos >= loop.pos && d.end <= loop.end)) return false;
        }
      }
    }
    return true;
  }
  private recordEligible(s: ts.Symbol): boolean {
    if (s === this.lexicalThisSym) return false;
    const d = s.valueDeclaration ?? s.declarations?.[0];
    if (!d) return false;
    if (ts.isFunctionExpression(d) || ts.isClassExpression(d)) return false;
    if (this.inLoop(d)) return false;
    return true;
  }
  /** A nested declaration that is only called directly is never hoisted as a
   *  closure, so its body must be lowered when the first direct call is seen. */
  /** A direct call to a nested declaration that its enclosing function has not
   *  hoisted (and so not lowered) yet. The body is lowered later, from the
   *  top-level driver, never re-entrantly along the call edge: lowering callees
   *  inside the caller's lowering recursed along the whole call graph of the
   *  compiler's checker (two thousand nested functions) and overflowed the
   *  stack. Normally hoistDeclarations lowers every nested declaration in
   *  lexical order before its first call is reached, so this stays empty. */
  private ensureNestedLowered(sym: ts.Symbol): void {
    const fid = this.funcSymbols.get(sym);
    if (fid === undefined || this.loweredFnIds.has(fid)) return;
    this.pendingNestedFns.add(fid);
  }
  /** Lower the nested declarations queued by ensureNestedLowered (each lowering
   *  may queue more). */
  private drainPendingNested(): void {
    while (this.pendingNestedFns.size > 0) {
      const fid = this.pendingNestedFns.values().next().value as number;
      this.pendingNestedFns.delete(fid);
      if (this.loweredFnIds.has(fid)) continue;
      const node = this.fnNodeById(fid);
      if (node) this.lowerFunctionLike(node as FnLike, fid, false);
    }
  }
  /** Every function declaration symbol that some identifier references other
   *  than as the callee of a direct call. Computed once before lowering so
   *  hoistDeclarations can skip the closure of a declaration that is only
   *  ever called (the dominant closure allocation in the compiler: a function
   *  with sixty nested helpers hoisted them all on each of 275k calls).
   *  TSAOT_LAZY_FN_DECL=0 keeps the eager hoisting. */
  private computeFunctionValueUses(): void {
    this.lazyFnDecls = process.env.TSAOT_LAZY_FN_DECL !== "0";
    if (!this.lazyFnDecls) return;
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && this.isVarRef(n)) {
        const parent = n.parent;
        let sym = this.symbolOf(n);
        // `{ g }` names the property; the value is the variable symbol.
        if (ts.isShorthandPropertyAssignment(parent) && parent.name === n)
          sym = this.checker.getShorthandAssignmentValueSymbol(parent) ?? sym;
        if (ts.isExportSpecifier(parent))
          sym = this.checker.getExportSpecifierLocalTargetSymbol(parent) ?? sym;
        if (sym && this.funcSymbols.has(sym)) {
          const isCallee = ts.isCallExpression(parent) && parent.expression === n;
          if (!isCallee) this.fnValueUsed.add(sym);
        }
      }
      ts.forEachChild(n, visit);
    };
    for (const m of this.modules) visit(m);
    if (process.env.TSAOT_DEBUG_FNVALUE) {
      console.error(`[fnvalue] used-as-value: [${[...this.fnValueUsed].map((s) => (s as { name?: string }).name ?? "?").join(",")}]`);
      console.error(`[fnvalue] funcSymbols: [${[...this.funcSymbols.keys()].map((s) => (s as { name?: string }).name ?? "?").join(",")}]`);
    }
  }
  /** Group the record-resident captured bindings by owner function and declare
   *  one synthetic class per owner (fields in binding-id order). Runs once the
   *  cell binding set is final and before any function is lowered. */
  private buildCaptureRecords(): void {
    this.captureContexts = process.env.TSAOT_CAPTURE_CONTEXTS !== "0" && this.cellClassId !== undefined;
    if (!this.captureContexts) return;
    const byOwner = new Map<ts.Node, ts.Symbol[]>();
    for (const s of this.cellBindings) {
      if (!this.recordEligible(s)) continue;
      const owner = this.symbolOwnerFunction(s);
      if (!owner) continue;
      let arr = byOwner.get(owner);
      if (!arr) { arr = []; byOwner.set(owner, arr); }
      arr.push(s);
    }
    const owners = [...byOwner.keys()].sort((a, b) => (this.fnId.get(a) ?? -1) - (this.fnId.get(b) ?? -1));
    for (const owner of owners) {
      const syms = byOwner.get(owner)!.sort((a, b) => this.bindingIdOf(a) - this.bindingIdOf(b));
      const classId = this.classInfos.length;
      const fields = new Map<ts.Symbol, number>();
      const ownFields: string[] = [];
      for (const sym of syms) {
        // the variable's name after the binding id, for diagnostics (the
        // field name is internal: records are never reflected on)
        const vname = ((sym as { name?: string }).name ?? "").replace(/[^A-Za-z0-9_$]/g, "");
        const fname = vname ? `c${this.bindingIdOf(sym)}_${vname}` : `c${this.bindingIdOf(sym)}`;
        ownFields.push(fname);
        fields.set(sym, this.internField(fname));
        this.recordOwnerOf.set(sym, owner);
      }
      const fid = this.fnId.get(owner);
      const ownerName = (owner as { name?: { text?: string } }).name?.text ?? `fn${fid ?? classId}`;
      this.classInfos.push({
        id: classId, name: `__ctx_${ownerName}`, ownMethods: [], ownFields,
        instantiated: true, stable: true, reasons: [],
      });
      // Typed capture-context fields (docs/int32_fields_design.md): a captured
      // variable whose declared type is a number (an enum: int32) and whose
      // every store the checker vouches for (no cast, no any, no destructuring:
      // collectUnsafeFieldStores) is an unboxed slot of the record, as a class
      // field of that type is. Only under the strict profile, like class
      // fields; TSAOT_TYPED_CTX_FIELDS=0 keeps the boxed cells.
      if (this.strictTypeOptimizationsEnabled() && process.env.TSAOT_TYPED_CTX_FIELDS !== "0") {
        const m = new Map<string, Set<string>>();
        for (const sym of syms) {
          if (this.unsafeVarSyms.has(sym)) continue;
          const decl = sym.valueDeclaration ?? sym.declarations?.[0];
          if (!decl) continue;
          let t: ts.Type;
          try { t = this.checker.getTypeOfSymbolAtLocation(sym, decl); } catch { continue; }
          if (this.classify(t) !== "primitive") continue;
          const vname = ((sym as { name?: string }).name ?? "").replace(/[^A-Za-z0-9_$]/g, "");
          m.set(vname ? `c${this.bindingIdOf(sym)}_${vname}` : `c${this.bindingIdOf(sym)}`, new Set([this.isInt32ValuedType(t) ? "int32" : "number"]));
        }
        if (m.size > 0) this.instFieldTypes.set(classId, m);
      }
      const sentinel = { name: `<ctx ${ownerName}>`, flags: 0 } as unknown as ts.Symbol;
      this.recordOfOwner.set(owner, { classId, binding: this.bindingIdOf(sentinel), fields, syms });
      if (process.env.TSAOT_DEBUG_RECORDS)
        console.error(`[record] ${ownerName}: ${syms.map((sy) => `${(sy as { name?: string }).name ?? "?"}${this.assignedSyms.has(sy) ? "=" : ""}${this.cellOnlySyms.has(sy) ? "!" : ""}`).join(",")}`);
    }
    if (this.moduleInitNode && this.recordOfOwner.has(this.moduleInitNode)) {
      this.moduleCtxGlobal = this.internGlobal("__modctx");
    }
  }
  /** The capture layout of a callee with free variables `frees`: one slot per
   *  distinct owner record (by record binding id), then one slot per cell-
   *  resident binding (by binding id). Pure in `frees`, so creation sites, call
   *  sites and the callee prologue agree. */
  captureSlots(frees: ts.Symbol[]): CaptureSlot[] {
    const cells: ts.Symbol[] = [];
    const values: ts.Symbol[] = [];
    const recs = new Map<ts.Node, ts.Symbol[]>();
    for (const s of frees) {
      if (this.valueBindings.has(s)) { values.push(s); continue; }
      const owner = this.captureContexts ? this.recordOwnerOf.get(s) : undefined;
      if (owner === undefined) { cells.push(s); continue; }
      let arr = recs.get(owner);
      if (!arr) { arr = []; recs.set(owner, arr); }
      arr.push(s);
    }
    const out: CaptureSlot[] = [];
    const owners = [...recs.keys()].sort(
      (a, b) => this.recordOfOwner.get(a)!.binding - this.recordOfOwner.get(b)!.binding);
    for (const owner of owners) {
      const rec = this.recordOfOwner.get(owner)!;
      out.push({ kind: "record", owner, binding: rec.binding, classId: rec.classId, syms: recs.get(owner)! });
    }
    cells.sort((a, b) => this.bindingIdOf(a) - this.bindingIdOf(b));
    for (const sym of cells) out.push({ kind: "cell", sym, binding: this.bindingIdOf(sym) });
    values.sort((a, b) => this.bindingIdOf(a) - this.bindingIdOf(b));
    for (const sym of values) out.push({ kind: "value", sym, binding: this.bindingIdOf(sym) });
    return out;
  }
  private slotName(slot: CaptureSlot): string {
    if (slot.kind === "cell" || slot.kind === "value") return (slot.sym as { name?: string }).name ?? "?";
    return `<record of ${(slot.owner as { name?: { text?: string } }).name?.text ?? "fn"}>`;
  }
  /** The local holding `owner`'s record here: the function's own record, the
   *  record parameter it received, or (module record only) a load of `__modctx`. */
  private availableRecord(ctx: FnCtx, owner: ts.Node): number | undefined {
    const held = ctx.recordLocals?.get(owner);
    if (held !== undefined) return held;
    if (owner === this.moduleInitNode && this.moduleCtxGlobal !== undefined) {
      // Loaded at every use (never cached in recordLocals): a load emitted on
      // one control-flow path is not available on another.
      const rec = this.recordOfOwner.get(owner)!;
      const lid = this.newLocal(ctx, "reference", "moduleCtx", rec.binding);
      ctx.body.push({ kind: "LoadGlobal", dst: lid, gref: this.moduleCtxGlobal });
      return lid;
    }
    return undefined;
  }
  /** Supply a capture slot at a creation/call site (module fallback allowed). */
  private supplySlot(ctx: FnCtx, slot: CaptureSlot): number | undefined {
    if (slot.kind === "value") return ctx.localOfSymbol.get(slot.sym);
    if (slot.kind === "cell") return this.availableCaptureCell(ctx, slot.sym);
    return this.availableRecord(ctx, slot.owner);
  }
  /** Supply a capture slot strictly from what this function holds (ctor paths). */
  private heldSlot(ctx: FnCtx, slot: CaptureSlot): number | undefined {
    if (slot.kind === "value") return ctx.localOfSymbol.get(slot.sym);
    if (slot.kind === "cell") return ctx.cellAccess.get(slot.sym);
    return ctx.recordLocals?.get(slot.owner);
  }
  /** Declare the leading parameter that receives one capture slot. */
  private bindCaptureParam(ctx: FnCtx, slot: CaptureSlot): void {
    if (slot.kind === "value") {
      // The value itself is the leading parameter; reads take the ordinary
      // local path (never captured storage), in the binding's declared kind.
      const d = slot.sym.valueDeclaration ?? slot.sym.declarations?.[0];
      const nameNode = d && (ts.isParameter(d) || ts.isVariableDeclaration(d)) && ts.isIdentifier(d.name) ? d.name : undefined;
      const kind: RefKind = nameNode ? this.refKindOf(nameNode) : "reference";
      const lid = this.newLocal(ctx, kind, `val_${(slot.sym as { name?: string }).name ?? "v"}`, slot.binding);
      ctx.localOfSymbol.set(slot.sym, lid);
      ctx.params.push(lid);
      try {
        const pcid = nameNode ? this.classOfExpr(nameNode) : undefined;
        if (pcid !== undefined) (ctx.paramClasses ||= {})[String(lid)] = pcid;
      } catch { /* ignore */ }
      return;
    }
    if (slot.kind === "cell") {
      const lid = this.newLocal(ctx, "reference", `cell_${(slot.sym as { name?: string }).name ?? "v"}`, slot.binding);
      ctx.cellAccess.set(slot.sym, lid);
      ctx.params.push(lid);
      this.markCellParam(ctx, lid);
      return;
    }
    const rec = this.recordOfOwner.get(slot.owner)!;
    const lid = this.newLocal(ctx, "reference", `ctx_${(slot.owner as { name?: { text?: string } }).name?.text ?? "fn"}`, slot.binding);
    (ctx.recordLocals ??= new Map()).set(slot.owner, lid);
    for (const sym of slot.syms) (ctx.recordAccess ??= new Map()).set(sym, { obj: lid, field: rec.fields.get(sym)! });
    ctx.params.push(lid);
    (ctx.paramClasses ??= {})[lid] = slot.classId;
  }
  /** Where a captured binding's value lives in this function: (record, field) or (cell, VALUE). */
  private capturedRef(ctx: FnCtx, sym: ts.Symbol): { obj: number; field: number } | undefined {
    const r = ctx.recordAccess?.get(sym);
    if (r !== undefined) return r;
    const cell = ctx.cellAccess.get(sym);
    if (cell !== undefined) return { obj: cell, field: this.VALUE };
    return undefined;
  }
  hasCaptured(ctx: FnCtx, sym: ts.Symbol): boolean {
    return (ctx.recordAccess?.has(sym) ?? false) || ctx.cellAccess.has(sym);
  }
  loadCaptured(ctx: FnCtx, sym: ts.Symbol, dst: number): void {
    const r = this.capturedRef(ctx, sym)!;
    ctx.body.push({ kind: "LoadField", dst, obj: r.obj, field: r.field });
  }
  storeCaptured(ctx: FnCtx, sym: ts.Symbol, src: number): void {
    const r = this.capturedRef(ctx, sym)!;
    ctx.body.push({ kind: "StoreField", obj: r.obj, field: r.field, src });
  }
  /** A module-scope binding published for methods (Step E): its record field,
   *  or the cell loaded from its GLOBALS[] slot. */
  private moduleCapturedRef(ctx: FnCtx, sym: ts.Symbol): { obj: number; field: number; cls?: number } | undefined {
    const owner = this.captureContexts ? this.recordOwnerOf.get(sym) : undefined;
    if (owner !== undefined) {
      const rl = this.availableRecord(ctx, owner);
      if (rl === undefined) return undefined;
      const rec = this.recordOfOwner.get(owner)!;
      return { obj: rl, field: rec.fields.get(sym)!, cls: this.recordClassHint(rec.classId) };
    }
    const gid = this.moduleCellGlobal.get(sym);
    if (gid === undefined) return undefined;
    const cell = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "LoadGlobal", dst: cell, gref: gid });
    return { obj: cell, field: this.VALUE, cls: this.cellClassId !== undefined ? this.recordClassHint(this.cellClassId) : undefined };
  }
  /** The receiver class hint of a read or write of a scope record or a cell
   *  loaded from its global: the exporter made the object, an instance of
   *  that class, in every profile (docs/receiver_class_hints_design.md). */
  private recordClassHint(classId: number): number | undefined {
    return process.env.TSAOT_CLASS_HINTS === "0" ? undefined : classId + 1;
  }
  /** The object that carries `sym` for a single-binding closure capture (the
   *  namespace export getter): record or cell, with the class and binding the
   *  callee must declare for it. */
  private captureContainer(ctx: FnCtx, sym: ts.Symbol):
      { obj: number; field: number; binding: number; classId: number | undefined } | undefined {
    const owner = this.captureContexts ? this.recordOwnerOf.get(sym) : undefined;
    if (owner !== undefined) {
      const rl = this.availableRecord(ctx, owner);
      if (rl === undefined) return undefined;
      const rec = this.recordOfOwner.get(owner)!;
      return { obj: rl, field: rec.fields.get(sym)!, binding: rec.binding, classId: rec.classId };
    }
    const cell = this.availableCaptureCell(ctx, sym);
    if (cell === undefined) return undefined;
    return { obj: cell, field: this.VALUE, binding: this.bindingIdOf(sym), classId: this.cellClassId };
  }

  private availableCaptureCell(ctx: FnCtx, sym: ts.Symbol): number | undefined {
    const local = ctx.cellAccess.get(sym);
    if (local !== undefined) return local;
    const global = this.moduleCellGlobal.get(sym);
    if (global === undefined) return undefined;
    const cell = this.newLocal(ctx, "reference", "moduleCell");
    ctx.body.push({ kind: "LoadGlobal", dst: cell, gref: global });
    return cell;
  }

  /** The closure value of a lazily hoisted nested declaration, from its
   *  storage here (record field, cell VALUE or the owner's local): loaded, and
   *  allocated and stored back when still undefined, so each activation creates
   *  it at most once and every use sees the same object. */
  private lazyFunctionValue(ctx: FnCtx, sym: ts.Symbol, at: ts.Node): number | undefined {
    const func = this.funcSymbols.get(sym);
    if (func === undefined) return undefined;
    const fnode = this.fnNodeById(func);
    if (!fnode || !isLiftable(fnode)) return undefined;
    const ref = this.capturedRef(ctx, sym);
    const local = ref ? undefined : ctx.localOfSymbol.get(sym);
    if (!ref && local === undefined) return undefined;
    const name = (sym as { name?: string }).name ?? "fn";
    const v = this.newLocal(ctx, "reference", name);
    if (ref) ctx.body.push({ kind: "LoadField", dst: v, obj: ref.obj, field: ref.field });
    else ctx.body.push({ kind: "Copy", dst: v, src: local! });
    const isUndef = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "UnOp", dst: isUndef, op: "isundef", operand: v });
    const thenBody = this.captureBody(ctx, () => {
      const captures: { binding: number; cell: number }[] = [];
      for (const slot of this.captureSlots(this.sortedFreeVars(fnode as FnLike))) {
        const cell = this.supplySlot(ctx, slot);
        if (cell === undefined)
          this.unsupported(at, `closure of '${name}' cannot capture '${this.slotName(slot)}' here (binding is unavailable)`);
        captures.push({ binding: slot.binding, cell: cell ?? this.newLocal(ctx, "reference", "missingCell") });
      }
      const made = this.newLocal(ctx, "reference", name);
      const site = this.site++;
      this.labels[site] = `${name}@${ctx.name}`;
      this.recordSite(site, "closure", this.inLoop(at) ? "many" : "once", true, fnode);
      ctx.body.push({ kind: "AllocClosure", dst: made, func, captures, site });
      ctx.body.push({ kind: "Copy", dst: v, src: made });
      if (ref) ctx.body.push({ kind: "StoreField", obj: ref.obj, field: ref.field, src: made });
      else ctx.body.push({ kind: "Copy", dst: local!, src: made });
    });
    ctx.body.push({ kind: "If", cond: isUndef, thenBody, elseBody: [] });
    return v;
  }
  private directFunctionValue(ctx: FnCtx, func: number): number | undefined {
    const node = this.fnNodeById(func);
    if (!node || !isLiftable(node)) return undefined;
    const sym = !ts.isArrowFunction(node) && node.name ? this.symbolOf(node.name) : undefined;
    if (sym) {
      if (this.lazyFnValueSyms.has(sym)) {
        const lazy = this.lazyFunctionValue(ctx, sym, node);
        if (lazy !== undefined) return lazy;
      }
      if (this.hasCaptured(ctx, sym)) {
        const value = this.newLocal(ctx, "reference", "callee");
        this.loadCaptured(ctx, sym, value);
        return value;
      }
      const global = this.functionValueGlobal.get(sym);
      if (global !== undefined) {
        const value = this.newLocal(ctx, "reference", "callee");
        ctx.body.push({ kind: "LoadGlobal", dst: value, gref: global });
        return value;
      }
    }
    const captures: { binding: number; cell: number }[] = [];
    for (const slot of this.captureSlots(this.sortedFreeVars(node))) {
      const cell = this.supplySlot(ctx, slot);
      if (cell === undefined) return undefined;
      captures.push({ binding: slot.binding, cell });
    }
    if (process.env.TSAOT_DEBUG_FNVALUE && sym) {
      const owner = this.recordOwnerOf.get(sym);
      console.error(`[fnvalue] ${ctx.name} creates ${(sym as { name?: string }).name}: cellBinding=${this.cellBindings.has(sym)} valueBinding=${this.valueBindings.has(sym)} recordOwner=${owner ? ((owner as { name?: { text?: string } }).name?.text ?? "fn") : "none"} recordLocal=${owner ? ctx.recordLocals?.get(owner) : "-"} recordAccess=${ctx.recordAccess?.has(sym)} cellAccess=${ctx.cellAccess.has(sym)}`);
    }
    const value = this.newLocal(ctx, "reference", "callee");
    const site = this.site++;
    this.recordSite(site, "closure", this.inLoop(node) ? "many" : "once", true, node);
    ctx.body.push({ kind: "AllocClosure", dst: value, func, captures, site });
    return value;
  }
  // Cells to prepend when calling Direct function `func` from `ctx`. If the
  // callee captures module cells, return the caller's locals holding those same
  // cells (in the callee's capture order). The caller is guaranteed to hold the
  // cells in cellAccess because it captures the same module bindings (the
  // free-var prepass added them transitively). Cells the caller lacks are
  // skipped defensively (filled with a fresh undefined to keep arity).
  directCallCellArgs(ctx: FnCtx, func: number): number[] {
    const node = this.fnNodeById(func);
    if (!node) return [];
    // Only top-level functions / __module_init participate in module-cell
    // threading. (Closures created via AllocClosure already carry their env.)
    const frees = this.sortedFreeVars(node as FnLike);
    if (process.env.TSAOT_DEBUG_CELLS) {
      const fname = (node as unknown as { name?: { text?: string } }).name?.text ?? `fn${func}`;
      console.error(`[cells] call->${fname}: frees=[${frees.map((s) => (s as { name?: string }).name ?? "?").join(",")}]`);
    }
    if (frees.length === 0) return [];
    const out: number[] = [];
    for (const slot of this.captureSlots(frees)) {
      const cell = this.supplySlot(ctx, slot);
      if (cell !== undefined) out.push(cell);
      else {
        // Caller doesn't hold a cell the callee needs. With the freeVars
        // fixpoint this is unreachable for module cells; if it ever fires,
        // reject LOUDLY — threading a fresh undefined local here was a silent
        // miscompile (the callee read garbage through the missing cell).
        this.unsupported(
          node,
          `direct call cannot thread captured cell '${this.slotName(slot)}' (caller does not hold it)`
        );
        const u = this.newLocal(ctx, "reference", "missingCell");
        out.push(u);
      }
    }
    return out;
  }

  /** Leading capture-cell args to thread into a Direct-called CONSTRUCTOR `func`
   *  for its FUNCTION-LOCAL captures (field initializers / dynamic-member keys &
   *  bodies — see freeVars). Module-scope captures are excluded (read via GLOBALS,
   *  matching lowerFunctionLike's isMethodLike param filter), so the order here
   *  equals the ctor prologue's cell-param order (both use sortedFreeVars). Returns
   *  null if a required cell isn't held at this call site (genuinely cross-scope) —
   *  the caller then loud-rejects instead of threading a garbage cell. */
  ctorCellArgs(ctx: FnCtx, func: number | undefined): number[] | null {
    if (func === undefined) return [];
    const node = this.fnNodeById(func);
    if (!node) return [];
    const frees = this.sortedFreeVars(node as FnLike).filter((s) => !this.moduleCellGlobal.has(s));
    const out: number[] = [];
    for (const slot of this.captureSlots(frees)) {
      const cell = this.heldSlot(ctx, slot);
      if (cell === undefined) return null; // cross-scope capture: can't supply -> reject
      out.push(cell);
    }
    return out;
  }

  /** Like ctorCellArgs but keeps the binding id with each cell (for an
   *  AllocClassValue's capture list). Order matches the ctor prologue cells. */
  classValueCaptures(ctx: FnCtx, ctor: number): { binding: number; cell: number }[] | null {
    const node = this.fnNodeById(ctor);
    if (!node) return [];
    const frees = this.sortedFreeVars(node as FnLike).filter((s) => !this.moduleCellGlobal.has(s));
    const out: { binding: number; cell: number }[] = [];
    for (const slot of this.captureSlots(frees)) {
      const cell = this.heldSlot(ctx, slot);
      if (cell === undefined) return null;
      out.push({ binding: slot.binding, cell });
    }
    return out;
  }

  /** Emit a Direct call to constructor `cfunc` on `instance`, threading any
   *  function-local capture cells as leading args (recv-less) so the call vector
   *  is [cells..., this, ...realArgs] — exactly the ctor prologue order. With no
   *  cells, keep the `recv = instance` form. `dst` captures the return (ctor-
   *  returns-object path). Loud-rejects (via ctorCellArgs===null) when a required
   *  capture cell isn't in scope at this site. */
  emitCtorCall(ctx: FnCtx, cfunc: number, instance: number, realArgs: number[], reportNode: ts.Node, dst?: number) {
    let cells = this.ctorCellArgs(ctx, cfunc);
    if (cells === null) {
      this.unsupported(reportNode, "constructor of a class that captures an enclosing function's local, instantiated where that local is not in scope (cross-scope capture not supported; instantiate in the capturing scope, move the class to module scope, or drop the explicit constructor)");
      cells = []; // emit a valid (recv) form; the reject aborts the compile
    }
    const inst: Record<string, unknown> = cells.length > 0
      ? { kind: "Call", args: [...cells, instance, ...realArgs], callee: { kind: "Direct", func: cfunc } }
      : { kind: "Call", recv: instance, args: realArgs, callee: { kind: "Direct", func: cfunc } };
    if (dst !== undefined) inst.dst = dst;
    ctx.body.push(inst);
  }

  // --------------------------- lowering ---------------------------------------
  /** A property/element access or call that participates in an optional chain. */
  private isOptChainAccess(n: ts.Node): n is ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression {
    return (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n))
      && ts.isOptionalChain(n);
  }

  /** True for the OUTERMOST node of an optional chain (the short-circuit boundary):
   *  it is a chain link, and its parent is not a chain link that contains it as its
   *  receiver (`.expression`). E.g. for `a?.b.c?.()` the root is the whole call. */
  private isOptionalChainRoot(node: ts.Node): boolean {
    if (!this.isOptChainAccess(node)) return false;
    const p = node.parent;
    if (p && this.isOptChainAccess(p) && (p as any).expression === node) return false;
    return true;
  }

  /** Lower an optional chain with proper short-circuit semantics. Each `?.` link's
   *  receiver is evaluated once (memoized via optChainBound) and nullish-guarded; if
   *  any guard is null/undefined the whole chain yields `undefined` and the rest of
   *  the chain (including any side effects) is not evaluated. The non-short-circuited
   *  value is produced by re-lowering the root through the normal access/call paths
   *  (which ignore the `?.` token), so all existing dispatch machinery is reused. */
  lowerOptionalChain(ctx: FnCtx, root: ts.Expression): number {
    const res = this.newLocal(ctx, this.refKindOf(root));
    ctx.body.push({ kind: "Const", dst: res, value: { kind: "Undef" } });

    // Collect each guarded link's receiver, innermost-first (bottom of the spine up).
    const guardRecvs: ts.Expression[] = [];
    let cur: ts.Node = root;
    while (this.isOptChainAccess(cur)) {
      if ((cur as any).questionDotToken) guardRecvs.push((cur as any).expression as ts.Expression);
      cur = (cur as any).expression;
    }
    guardRecvs.reverse();

    const emitGuard = (i: number): void => {
      if (i >= guardRecvs.length) {
        // All guards passed: compute the full chain value via the normal paths.
        this.optChainSkip.add(root);
        const v = this.lowerExpr(ctx, root);
        this.optChainSkip.delete(root);
        ctx.body.push({ kind: "Copy", dst: res, src: v });
        return;
      }
      const g = guardRecvs[i];
      const gv = this.lowerExpr(ctx, g);
      this.optChainBound.set(g, gv);
      const isNull = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "UnOp", dst: isNull, op: "nullish", operand: gv });
      const contBody = this.captureBody(ctx, () => emitGuard(i + 1));
      // null/undefined -> leave res as undefined; otherwise continue the chain.
      ctx.body.push({ kind: "If", cond: isNull, thenBody: [], elseBody: contBody });
    };
    emitGuard(0);

    for (const g of guardRecvs) this.optChainBound.delete(g);
    return res;
  }

  private regexpFlagsCanonical(flags: string): string {
    const order = "dgimsuvy";
    let out = "";
    for (const ch of order) if (flags.includes(ch)) out += ch;
    return out;
  }

  private regexpFlagsValid(flags: string): boolean {
    const seen = new Set<string>();
    for (const ch of flags) {
      if (seen.has(ch)) return false;
      seen.add(ch);
      if (!"dgimsuvy".includes(ch)) return false;
    }
    return !(seen.has("u") && seen.has("v"));
  }

  private regexpFlagMask(flags: string): number | undefined {
    if (!this.regexpFlagsValid(flags)) return undefined;
    let mask = 0;
    for (const ch of flags) {
      switch (ch) {
        case "g": mask |= 1 << 0; break;
        case "i": mask |= 1 << 1; break;
        case "m": mask |= 1 << 2; break;
        case "s": mask |= 1 << 3; break;
        case "u": mask |= 1 << 4; break;
        case "y": mask |= 1 << 5; break;
        case "d": mask |= 1 << 6; break;
        case "v": mask |= 1 << 7; break;
        default: return undefined;
      }
    }
    return mask;
  }

  /** A regexp literal's source, flags and mask; undefined for invalid flags (the runtime
   *  compiles the pattern: an invalid one throws a SyntaxError there). */
  private regexpLiteralFallbackPlan(raw: string) {
    const split = splitRegExpLiteral(raw);
    if (split === undefined) return undefined;
    const mask = this.regexpFlagMask(split.flags);
    if (mask === undefined) return undefined;
    return { rx: { source: split.source, flags: split.flags, global: split.flags.includes("g") }, mask };
  }

  private constIdentifierInitializer(expr: ts.Expression): ts.Expression | undefined {
    const u = this.unwrapExpr(expr);
    if (!ts.isIdentifier(u)) return undefined;
    const sym = this.symbolOf(u);
    const decl = (sym?.valueDeclaration ?? sym?.declarations?.[0]) as ts.Node | undefined;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    if (!decl.parent || !ts.isVariableDeclarationList(decl.parent)) return undefined;
    if ((decl.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
    return this.unwrapExpr(decl.initializer);
  }

  private isUndefinedConstValue(expr: ts.Expression | undefined): boolean {
    if (!expr) return true;
    const u = this.unwrapExpr(expr);
    if (u.kind === ts.SyntaxKind.UndefinedKeyword) return true;
    if (ts.isIdentifier(u) && u.text === "undefined" && this.isAmbientGlobalSymbol(this.symbolOf(u))) return true;
    const init = this.constIdentifierInitializer(u);
    return init !== undefined ? this.isUndefinedConstValue(init) : false;
  }

  private regexpRawFromConstExpr(expr: ts.Expression, depth = 0): string | undefined {
    if (depth > 4) return undefined;
    const u = this.unwrapExpr(expr);
    if (u.kind === ts.SyntaxKind.RegularExpressionLiteral) return u.getText();
    const init = this.constIdentifierInitializer(u);
    if (init === undefined) return undefined;
    const i = this.unwrapExpr(init);
    if ((ts.isCallExpression(i) || ts.isNewExpression(i)) &&
        ts.isIdentifier(i.expression) &&
        i.expression.text === "RegExp" &&
        this.isAmbientGlobalSymbol(this.symbolOf(i.expression))) {
      return this.regexpConstructorRawFromArgs(i.arguments, depth + 1);
    }
    return this.regexpRawFromConstExpr(i, depth + 1);
  }

  private constStringValue(expr: ts.Expression | undefined): string | undefined {
    if (!expr) return undefined;
    const u = this.unwrapExpr(expr);
    if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
    if (!ts.isIdentifier(u)) return undefined;
    const sym = this.symbolOf(u);
    const decl = (sym?.valueDeclaration ?? sym?.declarations?.[0]) as ts.Node | undefined;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    if (!decl.parent || !ts.isVariableDeclarationList(decl.parent)) return undefined;
    if ((decl.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
    const init = this.unwrapExpr(decl.initializer);
    return (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) ? init.text : undefined;
  }

  private regexpConstructorPatternSource(pattern: string): string {
    if (pattern.length === 0) return "(?:)";
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      switch (ch) {
        case "\n": out += "\\n"; break;
        case "\r": out += "\\r"; break;
        case "\u2028": out += "\\u2028"; break;
        case "\u2029": out += "\\u2029"; break;
        case "/": {
          let slashEscaped = false;
          let backslashes = 0;
          for (let j = i - 1; j >= 0 && pattern[j] === "\\"; j--) backslashes++;
          slashEscaped = (backslashes % 2) === 1;
          out += slashEscaped ? "/" : "\\/";
          break;
        }
        default:
          out += ch;
          break;
      }
    }
    return out;
  }

  private regexpConstructorRawFromArgs(args: ts.NodeArray<ts.Expression> | readonly ts.Expression[] | undefined, depth = 0): string | undefined {
    const arr = args ? Array.from(args) : [];
    let pattern = "";
    let flags = "";
    let patternWasRegExp = false;
    if (arr.length > 0) {
      if (this.isUndefinedConstValue(arr[0])) {
        pattern = this.regexpConstructorPatternSource("");
      } else {
        const p = this.constStringValue(arr[0]);
        if (p !== undefined) {
          pattern = this.regexpConstructorPatternSource(p);
        } else {
          const raw = this.regexpRawFromConstExpr(arr[0], depth + 1);
          if (raw === undefined) return undefined;
          const rx = splitRegExpLiteral(raw);
          if (rx === undefined || !this.regexpFlagsValid(rx.flags)) return undefined;
          pattern = rx.source;
          flags = rx.flags;
          patternWasRegExp = true;
        }
      }
    } else {
      pattern = this.regexpConstructorPatternSource("");
    }
    if (arr.length > 1) {
      if (this.isUndefinedConstValue(arr[1])) {
        if (!patternWasRegExp) flags = "";
      } else {
        const f = this.constStringValue(arr[1]);
        if (f === undefined || !this.regexpFlagsValid(f)) return undefined;
        flags = f;
      }
    } else if (!patternWasRegExp) {
      flags = "";
    }
    return `/${pattern}/${flags}`;
  }

  private regexpRawFromStringPatternArgs(args: ts.NodeArray<ts.Expression> | readonly ts.Expression[] | undefined): string | undefined {
    const arr = args ? Array.from(args) : [];
    if (arr.length === 0) return `/${this.regexpConstructorPatternSource("")}/`;
    if (this.isUndefinedConstValue(arr[0])) return `/${this.regexpConstructorPatternSource("")}/`;
    const pattern = this.constStringValue(arr[0]);
    if (pattern === undefined) return undefined;
    return `/${this.regexpConstructorPatternSource(pattern)}/`;
  }

  private regexpRawFromStringPatternMatchAllArgs(args: ts.NodeArray<ts.Expression> | readonly ts.Expression[] | undefined): string | undefined {
    const arr = args ? Array.from(args) : [];
    if (arr.length === 0) return `/${this.regexpConstructorPatternSource("")}/g`;
    if (this.isUndefinedConstValue(arr[0])) return `/${this.regexpConstructorPatternSource("")}/g`;
    const pattern = this.constStringValue(arr[0]);
    if (pattern === undefined) return undefined;
    return `/${this.regexpConstructorPatternSource(pattern)}/g`;
  }

  private lowerRegExpConstructor(ctx: FnCtx, node: ts.CallExpression | ts.NewExpression, hint?: string): number | undefined {
    const arr = node.arguments ? Array.from(node.arguments) : [];
    if (!ts.isNewExpression(node) &&
        arr.length > 0 &&
        (this.isRegExpExpr(arr[0]) || this.regexpRawFromConstExpr(arr[0]) !== undefined) &&
        (arr.length < 2 || this.isUndefinedConstValue(arr[1]))) {
      const same = this.lowerExpr(ctx, arr[0], hint);
      for (let i = 1; i < arr.length; i++) this.lowerExpr(ctx, arr[i]);
      return same;
    }
    const raw = this.regexpConstructorRawFromArgs(node.arguments);
    if (raw === undefined) {
      const args = this.lowerSequenced(ctx, arr);
      const undef = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: undef, value: { kind: "Undef" } });
      const dst = this.newLocal(ctx, "reference", hint);
      const construct = this.constNumber(ctx, ts.isNewExpression(node) ? 1 : 0);
      ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.construct", args: [args[0] ?? undef, args[1] ?? undef, construct] });
      return dst;
    }
    if (node.arguments) {
      for (let i = 2; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    }
    return this.lowerRegExpLiteralObject(ctx, node, raw, hint);
  }

  private lowerStringSearchStringPattern(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression): number | undefined {
    const raw = this.regexpRawFromStringPatternArgs(node.arguments);
    if (raw === undefined) return undefined;
    return this.lowerStringSearchRegExpFallback(ctx, node, recvExpr, raw);
  }

  private lowerStringMatchStringPattern(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression): number | undefined {
    const raw = this.regexpRawFromStringPatternArgs(node.arguments);
    if (raw === undefined) return undefined;
    return this.lowerStringMatchRegExpLiteral(ctx, node, recvExpr, raw);
  }

  private lowerStringMatchAllStringPattern(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression): number | undefined {
    const raw = this.regexpRawFromStringPatternMatchAllArgs(node.arguments);
    if (raw === undefined) return undefined;
    return this.lowerStringMatchAllRegExpLiteral(ctx, node, recvExpr, raw);
  }

  private isCallableExpression(expr: ts.Expression | undefined): boolean {
    if (!expr) return false;
    const u = this.unwrapExpr(expr);
    if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) return true;
    try {
      return this.checker.getTypeAtLocation(u).getCallSignatures().length > 0;
    } catch {
      return false;
    }
  }

  private constString(ctx: FnCtx, value: string, hint?: string): number {
    const dst = this.newLocal(ctx, "reference", hint);
    ctx.body.push({ kind: "Const", dst, value: { kind: "Str", value } });
    return dst;
  }

  /** Wire form of a numeric constant for the IR JSON. serde_json (analyzer side)
   *  mis-rounds large integer-valued floats written WITHOUT an exponent (a bare
   *  integer that overflows u64, e.g. `123456789012345680000`) by ~1 ULP. Emit
   *  those as an exponential STRING, which the analyzer parses with Rust's
   *  correctly-rounded std parser (ConstVal::Num accepts number or numeric string).
   *  Normal/safe numbers pass through as JSON numbers (unchanged output). */
  /** The literal a module-scope `const` is initialized with: a number (or a
   *  negated one), a string, true or false. Such a binding never changes, so a
   *  read is the constant (TSAOT_MODULE_CONST_FOLD=0 keeps the cell read). */
  private moduleConstLiteral(sym: ts.Symbol | undefined):
    { kind: "Num"; value: number | string } | { kind: "NegZero" } | { kind: "Str"; value: string } | { kind: "Bool"; value: boolean } | undefined {
    if (!sym || !this.moduleScopeSyms.has(sym) || process.env.TSAOT_MODULE_CONST_FOLD === "0") return undefined;
    const d = sym.valueDeclaration;
    if (!d || !ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || !d.initializer) return undefined;
    const list = d.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
    if (!ts.isVariableStatement(list.parent) || !ts.isSourceFile(list.parent.parent)) return undefined;
    let init: ts.Expression = d.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    const num = (lit: ts.NumericLiteral): number => Number(lit.text.replace(/_/g, ""));
    if (ts.isNumericLiteral(init)) return { kind: "Num", value: this.numWire(num(init)) };
    if (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(init.operand)) {
      const v = -num(init.operand);
      return Object.is(v, -0) ? { kind: "NegZero" } : { kind: "Num", value: this.numWire(v) };
    }
    if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return { kind: "Str", value: init.text };
    if (init.kind === ts.SyntaxKind.TrueKeyword) return { kind: "Bool", value: true };
    if (init.kind === ts.SyntaxKind.FalseKeyword) return { kind: "Bool", value: false };
    return undefined;
  }
  private numWire(value: number): number | string {
    if (Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      return value.toExponential();
    }
    return value;
  }
  /** A parameter that receives a captured-variable cell is typed with the
   *  synthetic cell class so its `__value` accesses use the struct layout. */
  private markCellParam(ctx: FnCtx, lid: number): void {
    if (this.cellClassId === undefined) return;
    (ctx.paramClasses ??= {})[lid] = this.cellClassId;
  }

  /** `E.A` / `E["A"]` on an enum member with a constant value folds to that constant. TypeScript's
   *  own emit inlines const enum members only (`getConstantValue` on the access answers for those
   *  alone); garnet folds an ordinary enum's literal members the same way: the program is typed, so
   *  the member is read-only in it and the enum object's property can only ever hold the declared
   *  value, and the receiver, an entity name, has no side effects to preserve. The enum object itself
   *  stays for the reflective uses (`Object.keys(E)`, `E[0]`). A computed member keeps its field
   *  load, and so does a member of an ambient (`declare`) enum, whose object comes from outside the
   *  program. `TSAOT_ENUM_FOLD=0` keeps the field loads of the ordinary enums. */
  private constEnumMemberValue(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): number | string | undefined {
    if (ts.isOptionalChain(node)) return undefined;
    let value: string | number | undefined;
    try { value = this.checker.getConstantValue(node); } catch { return undefined; }
    if (value === undefined && process.env.TSAOT_ENUM_FOLD !== "0") value = this.plainEnumMemberValue(node);
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    return undefined;
  }
  /** The constant of an ordinary enum's member named by `E.A` or `E["A"]` (undefined when the
   *  member is computed, the enum ambient, or the node not such an access). */
  private plainEnumMemberValue(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): number | string | undefined {
    const isEntityName = (e: ts.Expression): boolean =>
      ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) && isEntityName(e.expression));
    if (!isEntityName(node.expression)) return undefined;
    const nameNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
    if (!ts.isPropertyAccessExpression(node) && !ts.isStringLiteralLike(nameNode)) return undefined;
    let sym: ts.Symbol | undefined;
    try { sym = this.checker.getSymbolAtLocation(nameNode); } catch { return undefined; }
    if (!sym || !(sym.flags & ts.SymbolFlags.EnumMember)) return undefined;
    const decl = sym.valueDeclaration;
    if (!decl || !ts.isEnumMember(decl) || !ts.isEnumDeclaration(decl.parent)) return undefined;
    if (ts.getCombinedModifierFlags(decl.parent) & ts.ModifierFlags.Ambient) return undefined;
    try { return this.checker.getConstantValue(decl); } catch { return undefined; }
  }

  private lowerEnumConstant(ctx: FnCtx, value: number | string, hint?: string): number {
    return typeof value === "number" ? this.constNumber(ctx, value, hint) : this.constString(ctx, value, hint);
  }

  private constNumber(ctx: FnCtx, value: number, hint?: string): number {
    const dst = this.newLocal(ctx, "primitive", hint);
    ctx.body.push({ kind: "Const", dst, value: { kind: "Num", value: this.numWire(value) } });
    return dst;
  }

  private constBoxedBool(ctx: FnCtx, value: boolean, hint?: string): number {
    const dst = this.newLocal(ctx, "reference", hint);
    ctx.body.push({ kind: "Const", dst, value: { kind: "Bool", value } });
    return dst;
  }

  // An `enum E { A, B = 2, ... }` declaration desugars to a plain object bound to
  // `E`: each member `Name -> value` (numbers auto-increment from 0, or use the
  // explicit/constant-folded value), and numeric members additionally get the
  // reverse mapping `value -> "Name"` (so `E[0] === "A"`), matching tsc's emit.
  // Member values come from the checker's constant evaluation, which handles
  // auto-increment, explicit numeric/string initializers, and constant
  // expressions over earlier members; a non-constant member falls back to lowering
  // its initializer (and is treated as non-numeric, so it gets no reverse entry).
  /** True if `node` has an `export` modifier (namespace member visibility). */
  private isExportedDecl(node: ts.Node): boolean {
    return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  }

  /** A `namespace N { ... }` that produces a RUNTIME object (has value members),
   *  as opposed to a pure type namespace (`namespace N { export interface I {} }`)
   *  or an ambient `declare namespace` (no member bodies). String-named ambient
   *  modules (`declare module "x" {}`) and dotted `namespace A.B` are excluded. */
  /** True for a function declaration with a body declared directly in the
   *  block of a value namespace whose every enclosing namespace is itself a
   *  value namespace with a block body (the chain lowerModuleDeclaration
   *  lowers inline into __module_init). */
  private isValueNamespaceMember(n: ts.FunctionDeclaration): boolean {
    if (!n.body || !n.name || !ts.isModuleBlock(n.parent)) return false;
    let m: ts.Node = n.parent.parent;
    for (;;) {
      if (!ts.isModuleDeclaration(m) || !ts.isIdentifier(m.name) || !this.isValueNamespace(m)) return false;
      if (ts.isSourceFile(m.parent)) return true;
      if (ts.isModuleBlock(m.parent) && ts.isModuleDeclaration(m.parent.parent)) { m = m.parent.parent; continue; }
      return false;
    }
  }

  /** `N.f` where `N` resolves to the value namespace declaring the function
   *  `f` (a registered namespaceFuncSymbols member that does not read `this`):
   *  the member's symbol and function id, for a direct call. */
  private namespaceMemberCallTarget(fn: ts.PropertyAccessExpression): { sym: ts.Symbol; fnId: number } | undefined {
    if (!this.namespaceDirect || !ts.isIdentifier(fn.expression)) return undefined;
    const msym = this.symbolOf(fn.name);
    if (!msym || !this.namespaceFuncSymbols.has(msym)) return undefined;
    const fid = this.funcSymbols.get(msym);
    if (fid === undefined || this.funcTakesThisIds.has(fid)) return undefined;
    const decl = msym.valueDeclaration;
    if (!decl || !ts.isFunctionDeclaration(decl) || !ts.isModuleBlock(decl.parent) ||
        !ts.isModuleDeclaration(decl.parent.parent) || !ts.isIdentifier(decl.parent.parent.name)) return undefined;
    const nsym = this.symbolOf(decl.parent.parent.name);
    const rsym = this.symbolOf(fn.expression);
    if (!nsym || !rsym || nsym !== rsym) return undefined;
    return { sym: msym, fnId: fid };
  }

  private isValueNamespace(stmt: ts.ModuleDeclaration): boolean {
    if (!ts.isIdentifier(stmt.name)) return false;
    // `declare global` / `declare namespace`: the environment provides the
    // values, nothing is built here
    if (stmt.flags & AMBIENT_NODE_FLAG) return false;
    if (!stmt.body || !ts.isModuleBlock(stmt.body)) return false;
    return stmt.body.statements.some((s) =>
      (ts.isFunctionDeclaration(s) && !!s.body) ||
      ts.isVariableStatement(s) ||
      ts.isClassDeclaration(s) ||
      ts.isEnumDeclaration(s) ||
      (ts.isModuleDeclaration(s) && this.isValueNamespace(s)));
  }

  /** Record a value namespace's member bindings (functions, vars, classes, enums,
   *  nested namespaces) in moduleScopeSyms so symbolOwnerFunction routes them to
   *  __module_init (the namespace body is lowered inline there). */
  private registerNamespaceMemberSyms(stmt: ts.ModuleDeclaration): void {
    if (!stmt.body || !ts.isModuleBlock(stmt.body)) return;
    const add = (n: ts.Node | undefined) => { const s = n ? this.symbolOf(n) : undefined; if (s) this.moduleScopeSyms.add(s); };
    for (const s of stmt.body.statements) {
      if (ts.isFunctionDeclaration(s) && s.name) add(s.name);
      else if (ts.isVariableStatement(s)) {
        const bind = (name: ts.BindingName) => {
          if (ts.isIdentifier(name)) {
            add(name);
            const sym = this.symbolOf(name);
            if (sym && this.isExportedDecl(s) && ts.isIdentifier(stmt.name))
              this.namespaceBindings.set(sym, { namespace: stmt.name, name: name.text });
          } else for (const el of name.elements) if (ts.isBindingElement(el)) bind(el.name);
        };
        for (const d of s.declarationList.declarations) bind(d.name);
      }
      else if (ts.isClassDeclaration(s) && s.name) add(s.name);
      else if (ts.isEnumDeclaration(s)) add(s.name);
      else if (ts.isModuleDeclaration(s) && ts.isIdentifier(s.name) && this.isValueNamespace(s)) { add(s.name); this.registerNamespaceMemberSyms(s); }
    }
  }

  /** True if `stmt` is `import * as ns from "<bundled module>"`. */
  private isNamespaceImportStmt(stmt: ts.Statement): stmt is ts.ImportDeclaration {
    if (!ts.isImportDeclaration(stmt)) return false;
    const nb = stmt.importClause?.namedBindings;
    return !!nb && ts.isNamespaceImport(nb) && !!this.resolveModuleSf(stmt.moduleSpecifier);
  }

  private defineModuleExportGetter(ctx: FnCtx, obj: number, name: string, sym: ts.Symbol, node: ts.Node): void {
    const cont = this.captureContainer(ctx, sym);
    if (cont === undefined) {
      this.unsupported(node, `namespace export '${name}' has no binding cell`);
      return;
    }
    let func = this.namespaceGetterFunctions.get(sym);
    if (func === undefined) {
      func = this.allocSpecFn();
      this.namespaceGetterFunctions.set(sym, func);
      this.noteFnModule(func, node.getSourceFile().fileName);
      this.functions.push({
        id: func, name: `__get_export_${name}`, params: [0], ret: 0,
        locals: [{ id: 0, typeId: 0, refKind: "reference" }, { id: 1, typeId: 0, refKind: "reference" }],
        body: [{ kind: "LoadField", dst: 1, obj: 0, field: cont.field }, { kind: "Return", src: 1 }],
        isExported: false, paramClasses: cont.classId !== undefined ? { 0: cont.classId } : {}, restParam: null,
        isAsync: false, isGenerator: false, takesThis: false, captureCount: 1, arity: 0, hasPrototype: false,
      });
    }
    const getter = this.newLocal(ctx, "reference");
    const site = this.site++;
    this.recordSite(site, "closure", "once", true, node);
    ctx.body.push({ kind: "AllocClosure", dst: getter, func, captures: [{ binding: cont.binding, cell: cont.obj }], site });
    const key = this.constString(ctx, name);
    const setter = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: setter, value: { kind: "Undef" } });
    ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "object.defineAccessor:0:0:1:0", args: [obj, key, getter, setter] });
  }

  /** Module namespace reads follow the original export cells, including mutable
   *  and reexported bindings. Repeated imports share one namespace object. */
  private lowerNamespaceImport(ctx: FnCtx, stmt: ts.ImportDeclaration): void {
    const nb = stmt.importClause!.namedBindings as ts.NamespaceImport;
    this.materializeNamespace(ctx, stmt.moduleSpecifier, nb.name, stmt);
  }
  /** The namespace object of the module `moduleSpecifier` names, bound as `name` (`import * as name` and
   *  `export * as name from`): the module's exports as fields (getters for the exports that live in cells). */
  private materializeNamespace(ctx: FnCtx, moduleSpecifier: ts.Expression, name: ts.Identifier, stmt: ts.Statement): void {
    const target = this.resolveModuleSf(moduleSpecifier);
    if (!target) return;
    const modSym = this.checker.getSymbolAtLocation(target) ?? (target as unknown as { symbol?: ts.Symbol }).symbol;
    if (!modSym) return;
    if (this.moduleNamespaceLocals.has(modSym)) return;
    const site = this.site++;
    const obj = this.newLocal(ctx, "reference", name.text);
    this.recordSite(site, "object", "once", false, stmt);
    ctx.body.push({ kind: "AllocObject", dst: obj, typeId: 0, site });
    this.moduleNamespaceLocals.set(modSym, obj);
    // `ns` references unwrap (symbolOf) to the module symbol; bind it there. Also
    // bind the alias symbol itself defensively.
    if (this.hasCaptured(ctx, modSym)) this.storeCaptured(ctx, modSym, obj);
    else this.ensureLocalAlias(ctx, modSym, obj);
    const aliasSym = this.checker.getSymbolAtLocation(name);
    if (aliasSym && aliasSym !== modSym) this.ensureLocalAlias(ctx, aliasSym, obj);
    const nullValue = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: nullValue, value: { kind: "Null" } });
    ctx.body.push({ kind: "SetProto", dst: this.newLocal(ctx, "reference"), obj, proto: nullValue });
    const exports = [...this.checker.getExportsOfModule(modSym)].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const exp of exports) {
      const name = exp.name;
      const canonical = this.unwrapImportAlias(exp) ?? exp;
      const decl = (canonical.valueDeclaration ?? canonical.declarations?.[0]) as ts.Node | undefined;
      if (!decl) continue; // type-only export (interface/type alias) — erased
      if (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) continue;
      if (this.cellBindings.has(canonical) && this.moduleScopeSyms.has(canonical)) {
        this.defineModuleExportGetter(ctx, obj, name, canonical, stmt);
        continue;
      }
      const nameNode = (decl as unknown as { name?: ts.Node }).name;
      if (nameNode && ts.isIdentifier(nameNode)) {
        const v = this.lowerIdentifier(ctx, nameNode);
        ctx.body.push({ kind: "StoreField", obj, field: this.internField(name), src: v });
      }
    }
    const tag = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst: tag, builtin: "symbol.wksym:4", args: [] });
    ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "object.defineData:0:0:0", args: [obj, tag, this.constString(ctx, "Module")] });
    ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "object.preventExtensions", args: [obj] });
  }

  /** Lower a STANDALONE `namespace N { ... }` to a runtime object (the IIFE pattern
   *  `var N = {}; N.f = f; ...`). Exported members become object properties; non-
   *  exported members are private locals (still reachable by exported closures via
   *  the existing free-var/cell machinery). A namespace merged with a same-named
   *  CLASS is handled separately via the class's static container (lowerStaticInit),
   *  not here. Mirrors lowerEnumDeclaration. */
  private lowerModuleDeclaration(ctx: FnCtx, stmt: ts.ModuleDeclaration): void {
    if (!stmt.body || !ts.isModuleBlock(stmt.body)) return;
    const nsym = ts.isIdentifier(stmt.name) ? this.symbolOf(stmt.name) : undefined;
    // bind a symbol to a value: through its cell if captured, else a local alias.
    const bindSym = (sym: ts.Symbol | undefined, local: number) => {
      if (!sym) return;
      if (this.hasCaptured(ctx, sym)) this.storeCaptured(ctx, sym, local);
      else this.ensureLocalAlias(ctx, sym, local);
    };
    // Target object: a namespace merged with a same-named CLASS installs its
    // members on the class's static container (so `X.member` resolves like a
    // static); a standalone namespace allocates/reuses its own object.
    const mergeCid = nsym !== undefined ? this.classSymToId.get(nsym) : undefined;
    let obj: number;
    if (mergeCid !== undefined) {
      const cc = this.staticContainerClassOf(mergeCid);
      if (cc === undefined) { this.unsupported(stmt, "class+namespace merge could not find the class's static container"); return; }
      obj = this.newLocal(ctx, "reference", (stmt.name as ts.Identifier).text);
      ctx.body.push({ kind: "LoadGlobal", dst: obj, gref: this.classStaticGlobal.get(cc)! });
    } else {
      // Reuse an existing object for repeated `namespace N {}` declarations (merge).
      const already = nsym !== undefined && this.materializedNamespaces.has(nsym);
      if (already && nsym) {
        if (this.hasCaptured(ctx, nsym)) {
          obj = this.newLocal(ctx, "reference", (stmt.name as ts.Identifier).text);
          this.loadCaptured(ctx, nsym, obj);
        } else {
          obj = ctx.localOfSymbol.get(nsym)!;
        }
      } else {
        const site = this.site++;
        obj = this.newLocal(ctx, "reference", (stmt.name as ts.Identifier).text);
        this.recordSite(site, "object", "once", false, stmt);
        ctx.body.push({ kind: "AllocObject", dst: obj, typeId: 0, site });
        bindSym(nsym, obj);
        if (nsym) this.materializedNamespaces.add(nsym);
      }
    }
    const put = (name: string, src: number) =>
      ctx.body.push({ kind: "StoreField", obj, field: this.internField(name), src });
    for (const s of stmt.body.statements) {
      const exported = this.isExportedDecl(s);
      if (ts.isFunctionDeclaration(s) && s.body && s.name) {
        const fnLocal = this.lowerClosure(ctx, s as FnLike, s.name.text, false);
        bindSym(this.symbolOf(s.name), fnLocal);
        if (exported) put(s.name.text, fnLocal);
      } else if (ts.isVariableStatement(s)) {
        this.lowerStmt(ctx, s);
        for (const d of s.declarationList.declarations) {
          if (!exported || !d.initializer) continue;
          const publish = (name: ts.BindingName) => {
            if (ts.isIdentifier(name)) {
              const sym = this.symbolOf(name);
              if (!sym) return;
              let value = ctx.localOfSymbol.get(sym);
              if (this.hasCaptured(ctx, sym)) {
                value = this.newLocal(ctx, "reference");
                this.loadCaptured(ctx, sym, value);
              }
              if (value !== undefined) put(name.text, value);
            } else for (const el of name.elements) if (ts.isBindingElement(el)) publish(el.name);
          };
          publish(d.name);
        }
      } else if (ts.isClassDeclaration(s) && s.name) {
        const csym = this.symbolOf(s.name);
        const cid = csym ? this.classSymToId.get(csym) : undefined;
        if (cid !== undefined) {
          const cv = this.emitClassValue(ctx, cid, s.name.text, s, false);
          if (cv !== undefined) {
            if (cv.classValue) this.linkClassValueStaticContainer(ctx, cv.local, cid);
            bindSym(csym, cv.local);
            if (exported) put(s.name.text, cv.local);
          }
        }
      } else if (ts.isModuleDeclaration(s) && ts.isIdentifier(s.name) && this.isValueNamespace(s)) {
        this.lowerModuleDeclaration(ctx, s);
        const msym = this.symbolOf(s.name);
        if (exported && msym && ctx.localOfSymbol.has(msym)) put(s.name.text, ctx.localOfSymbol.get(msym)!);
      } else if (ts.isEnumDeclaration(s)) {
        this.lowerEnumDeclaration(ctx, s);
        const esym = this.symbolOf(s.name);
        if (exported && esym && ctx.localOfSymbol.has(esym)) put(s.name.text, ctx.localOfSymbol.get(esym)!);
      }
      // interface / type alias / `export type` -> erased (type-only)
    }
  }

  private lowerEnumDeclaration(ctx: FnCtx, stmt: ts.EnumDeclaration): void {
    const esym = this.symbolOf(stmt.name);
    const site = this.site++;
    const obj = this.newLocal(ctx, "reference", stmt.name.text);
    this.recordSite(site, "object", "once", false, stmt);
    ctx.body.push({ kind: "AllocObject", dst: obj, typeId: 0, site });
    const memberName = (m: ts.EnumMember): string | undefined => {
      const n = m.name;
      if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
      this.unsupported(m, `enum member with computed name`);
      return undefined;
    };
    for (const m of stmt.members) {
      const name = memberName(m);
      if (name === undefined) continue;
      const cv = this.checker.getConstantValue(m);
      let valLocal: number;
      let numericValue: number | undefined;
      if (typeof cv === "number") {
        valLocal = this.constNumber(ctx, cv, "enumval");
        numericValue = cv;
      } else if (typeof cv === "string") {
        valLocal = this.constString(ctx, cv, "enumval");
      } else if (m.initializer) {
        valLocal = this.lowerExpr(ctx, m.initializer);
      } else {
        this.unsupported(m, `enum member with non-constant value`);
        continue;
      }
      // Use StoreField with a compile-time-interned field key so member reads
      // (`E.A` -> LoadField, `E[0]` -> element access on the same canonical key)
      // resolve to the same slot. defineData would intern the key at runtime in a
      // separate path and the static reads would miss it.
      ctx.body.push({ kind: "StoreField", obj, field: this.internField(name), src: valLocal });
      if (numericValue !== undefined) {
        const nameLocal = this.constString(ctx, name, "enumkey");
        ctx.body.push({ kind: "StoreField", obj, field: this.internField(String(numericValue)), src: nameLocal });
      }
    }
    if (esym) {
      if (this.hasCaptured(ctx, esym)) {
        this.storeCaptured(ctx, esym, obj);
      } else {
        this.ensureLocalAlias(ctx, esym, obj);
      }
    }
  }

  private defineDataField(ctx: FnCtx, obj: number, key: string, value: number, enumerable: 0 | 1, writable: 0 | 1, configurable: 0 | 1): void {
    const keyLocal = this.constString(ctx, key, `${key}.key`);
    ctx.body.push({
      kind: "CallBuiltinStatic",
      dst: this.newLocal(ctx, "reference"),
      builtin: `object.defineData:${enumerable}:${writable}:${configurable}`,
      args: [obj, keyLocal, value],
    });
  }

  /** A regexp literal (or a constructor call with constant arguments): one RegExp object
   *  from the source and the flag mask (`regexp.newLiteral`, docs/regexp_vm_design.md). */
  private lowerRegExpLiteralObject(ctx: FnCtx, node: ts.Expression, raw: string, hint?: string): number | undefined {
    const fallback = this.regexpLiteralFallbackPlan(raw);
    if (fallback === undefined) return undefined;
    const { rx, mask } = fallback;
    const src = this.constString(ctx, rx.source, "rxSource");
    const flags = this.constNumber(ctx, mask, "rxFlags");
    const dst = this.newLocal(ctx, "reference", hint ?? "regexp");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.newLiteral", args: [src, flags] });
    return dst;
  }

  private isRegExpExpr(e: ts.Expression): boolean {
    const u = this.unwrapExpr(e);
    if (u.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
    if (this.regexpRawFromConstExpr(u) !== undefined) return true;
    return this.typeNameOf(u) === "RegExp";
  }

  private lowerRegExpLiteralTestFallback(ctx: FnCtx, node: ts.CallExpression, raw: string): number | undefined {
    const plan = this.regexpLiteralFallbackPlan(raw);
    if (plan === undefined) return undefined;
    const { rx, mask } = plan;
    const argLs = this.lowerSequenced(ctx, node.arguments);
    const rawArg = argLs[0] ?? (() => {
      const u = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
      return u;
    })();
    const src = rawArg;   // the adapter applies ToString
    const pat = this.constString(ctx, rx.source, "rxSource");
    const flags = this.constNumber(ctx, mask, "rxFlags");
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.quickTest", args: [pat, flags, src] });
    return dst;
  }

  private lowerRegExpLiteralExecFallback(ctx: FnCtx, node: ts.CallExpression, raw: string): number | undefined {
    const plan = this.regexpLiteralFallbackPlan(raw);
    if (plan === undefined) return undefined;
    const { rx, mask } = plan;
    const argLs = this.lowerSequenced(ctx, node.arguments);
    const rawArg = argLs[0] ?? (() => {
      const u = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
      return u;
    })();
    const src = rawArg;   // the adapter applies ToString
    const pat = this.constString(ctx, rx.source, "rxSource");
    const flags = this.constNumber(ctx, mask, "rxFlags");
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.quickExec", args: [pat, flags, src] });
    return dst;
  }

  private lowerStringMatchRegExpLiteral(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, raw: string): number | undefined {
    const plan = this.regexpLiteralFallbackPlan(raw);
    if (plan === undefined) return undefined;
    const { rx, mask } = plan;
    const recv = this.lowerExpr(ctx, recvExpr);
    for (let i = 1; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const pat = this.constString(ctx, rx.source, "rxSource");
    const flags = this.constNumber(ctx, mask, "rxFlags");
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.quickMatch", args: [recv, pat, flags] });
    return dst;
  }

  private lowerStringMatchAllRegExpLiteral(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, raw: string): number | undefined {
    const plan = this.regexpLiteralFallbackPlan(raw);
    if (plan === undefined) return undefined;
    const { rx, mask } = plan;
    const recv = this.lowerExpr(ctx, recvExpr);
    for (let i = 1; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const pat = this.constString(ctx, rx.source, "rxSource");
    const flags = this.constNumber(ctx, mask, "rxFlags");
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.quickMatchAll", args: [recv, pat, flags] });
    return dst;
  }

  private lowerStringReplaceRegExpLiteral(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, raw: string, replaceAll: boolean): number | undefined {
    const plan = this.regexpLiteralFallbackPlan(raw);
    if (plan === undefined) return undefined;
    const { rx, mask } = plan;
    const recv = this.lowerExpr(ctx, recvExpr);
    const replacement = node.arguments[1] !== undefined
      ? this.lowerExpr(ctx, node.arguments[1])
      : (() => {
        const u = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
        return u;
      })();
    for (let i = 2; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const pat = this.constString(ctx, rx.source, "rxSource");
    const flags = this.constNumber(ctx, mask, "rxFlags");
    const mode = this.constNumber(ctx, replaceAll ? 1 : 0, "replaceAll");
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.quickReplace", args: [recv, pat, flags, replacement, mode] });
    return dst;
  }

  private lowerStringSplitRegExpLiteral(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, raw: string): number | undefined {
    const plan = this.regexpLiteralFallbackPlan(raw);
    if (plan === undefined) return undefined;
    const { rx, mask } = plan;
    const recv = this.lowerExpr(ctx, recvExpr);
    const limit = node.arguments[1] !== undefined
      ? this.lowerExpr(ctx, node.arguments[1])
      : (() => {
        const u = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
        return u;
      })();
    for (let i = 2; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const pat = this.constString(ctx, rx.source, "rxSource");
    const flags = this.constNumber(ctx, mask, "rxFlags");
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.quickSplit", args: [recv, pat, flags, limit] });
    return dst;
  }

  private lowerStringSearchRegExpFallback(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, raw: string): number | undefined {
    const plan = this.regexpLiteralFallbackPlan(raw);
    if (plan === undefined) return undefined;
    const { rx, mask } = plan;
    const recv = this.lowerExpr(ctx, recvExpr);
    for (let i = 1; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const pat = this.constString(ctx, rx.source, "rxSource");
    const flags = this.constNumber(ctx, mask, "rxFlags");
    const dst = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.quickSearch", args: [recv, pat, flags] });
    return dst;
  }

  private lowerRegExpObjectTestCall(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression): number {
    const recv = this.lowerExpr(ctx, recvExpr);
    const argLs = this.lowerSequenced(ctx, node.arguments);
    const rawArg = argLs[0] ?? (() => {
      const u = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
      return u;
    })();
    const src = rawArg;   // the adapter applies ToString
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.objectTest", args: [recv, src] });
    return dst;
  }

  private lowerRegExpObjectExecCall(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression): number {
    const recv = this.lowerExpr(ctx, recvExpr);
    const argLs = this.lowerSequenced(ctx, node.arguments);
    const rawArg = argLs[0] ?? (() => {
      const u = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
      return u;
    })();
    const src = rawArg;   // the adapter applies ToString
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.objectExec", args: [recv, src] });
    return dst;
  }

  private lowerStringSearchRegExpObject(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, regexpExpr: ts.Expression): number {
    const recv = this.lowerExpr(ctx, recvExpr);
    const regexp = this.lowerExpr(ctx, regexpExpr);
    for (let i = 1; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const dst = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.objectSearch", args: [recv, regexp] });
    return dst;
  }

  private lowerStringMatchRegExpObject(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, regexpExpr: ts.Expression): number {
    const recv = this.lowerExpr(ctx, recvExpr);
    const regexp = this.lowerExpr(ctx, regexpExpr);
    for (let i = 1; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.objectMatch", args: [recv, regexp] });
    return dst;
  }

  private lowerStringMatchAllRegExpObject(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, regexpExpr: ts.Expression): number | undefined {
    const recv = this.lowerExpr(ctx, recvExpr);
    const regexp = this.lowerExpr(ctx, regexpExpr);
    for (let i = 1; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.objectMatchAll", args: [recv, regexp] });
    return dst;
  }

  private lowerStringReplaceRegExpObject(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, regexpExpr: ts.Expression, replaceAll: boolean): number | undefined {
    const recv = this.lowerExpr(ctx, recvExpr);
    const regexp = this.lowerExpr(ctx, regexpExpr);
    const replacement = node.arguments[1] !== undefined
      ? this.lowerExpr(ctx, node.arguments[1])
      : (() => {
        const u = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
        return u;
      })();
    for (let i = 2; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const mode = this.constNumber(ctx, replaceAll ? 1 : 0, "replaceAll");
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.objectReplace", args: [recv, regexp, replacement, mode] });
    return dst;
  }

  private lowerStringSplitRegExpObject(ctx: FnCtx, node: ts.CallExpression, recvExpr: ts.Expression, regexpExpr: ts.Expression): number {
    const recv = this.lowerExpr(ctx, recvExpr);
    const regexp = this.lowerExpr(ctx, regexpExpr);
    const limit = node.arguments[1] !== undefined
      ? this.lowerExpr(ctx, node.arguments[1])
      : (() => {
        const u = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
        return u;
      })();
    for (let i = 2; i < node.arguments.length; i++) this.lowerExpr(ctx, node.arguments[i]);
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.objectSplit", args: [recv, regexp, limit] });
    return dst;
  }

  /** Resolve the classic JSX factory from `import * as React from "./..."`.
   *
   *  The import target is part of the whole-program bundle, so a top-level
   *  `createElement` function can be called directly by fn id. This is the AOT
   *  fast path: no namespace-object lookup, property PIC, or indirect call at
   *  each JSX site. The namespace identifier remains available for a semantic
   *  fallback and for loading React.Fragment. */
  /** Whether `fileName` is garnet's own module `lib/garnet/<name>.ts`. */
  private isGarnetLibFile(fileName: string, name: string): boolean {
    return fileName.replace(/\\/g, "/").endsWith("/lib/garnet/" + name + ".ts");
  }

  /** A one-argument call of garnet:json's `parse` (`parse<T>(s)` or `JSON.parse<T>(s)` on
   *  the module's `JSON` export): the parse function and the schema of the call's T. */
  private typedJsonParseCall(node: ts.CallExpression): { func: number; schema: string } | undefined {
    if (node.arguments.length !== 1 || ts.isSpreadElement(node.arguments[0]) || node.questionDotToken) return undefined;
    const fn = node.expression;
    let sym: ts.Symbol | undefined;
    if (ts.isIdentifier(fn)) {
      sym = this.symbolOf(fn);                 // the import alias unwrapped: the module's `parse`
      if (!sym || sym.name !== "parse") return undefined;
    } else if (ts.isPropertyAccessExpression(fn) && fn.name.text === "parse" && ts.isIdentifier(fn.expression)) {
      sym = this.symbolOf(fn.expression);      // the module's `JSON` object
      if (!sym || sym.name !== "JSON") return undefined;
    } else return undefined;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) return undefined;
    const sf = decl.getSourceFile();
    if (!this.isGarnetLibFile(sf.fileName, "json")) return undefined;
    const modSym = this.checker.getSymbolAtLocation(sf) ?? (sf as unknown as { symbol?: ts.Symbol }).symbol;
    if (!modSym) return undefined;
    const exported = this.checker.getExportsOfModule(modSym).find((s) => s.name === "parse");
    const parseSym = exported ? (this.unwrapImportAlias(exported) ?? exported) : undefined;
    const func = parseSym ? this.funcSymbols.get(parseSym) : undefined;
    if (func === undefined) return undefined;
    const t = this.checker.getResolvedSignature(node)?.getReturnType();
    if (!t) return undefined;
    const schema = this.typedJsonSchema(t, node);
    if (schema === undefined) return undefined;
    if (process.env.TSAOT_TYPED_JSON_LOG === "1") {
      const at = node.getSourceFile();
      const pos = at.getLineAndCharacterOfPosition(node.getStart());
      process.stderr.write(`[typed-json] ${path.basename(at.fileName)}:${pos.line + 1} ${this.checker.typeToString(t)} -> ${schema}\n`);
    }
    return { func, schema };
  }

  /** The schema string of a type (docs/typed_json_design.md), or undefined after a
   *  loud reject when the type has a part JSON cannot carry. */
  private typedJsonSchema(root: ts.Type, node: ts.Node): string | undefined {
    const checker = this.checker;
    const defs: string[] = [];
    const defNames = new Map<number, string>();
    const usedNames = new Set<string>();
    const visiting = new Set<number>();
    let failure: string | undefined;
    const fail = (what: string): string => { if (failure === undefined) failure = what; return '"*"'; };
    const idOf = (t: ts.Type): number => (t as unknown as { id: number }).id;
    const nameOf = (t: ts.Type): string => {
      const own = t.symbol && t.symbol.name !== "__type" && t.symbol.name !== "__object" ? t.symbol.name : undefined;
      const base = t.aliasSymbol?.name ?? own ?? "T";
      let name = base;
      for (let k = 2; usedNames.has(name); k++) name = base + k;
      usedNames.add(name);
      return name;
    };
    const ref = (id: number): string => `{"k":"ref","n":${JSON.stringify(defNames.get(id))}}`;
    const lit = (v: string | number | boolean): string => `{"k":"l","v":${JSON.stringify(v)}}`;
    const isTrue = (t: ts.Type): boolean => (t as unknown as { intrinsicName?: string }).intrinsicName === "true";
    const schema = (t: ts.Type): string => {
      const f = t.flags;
      if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return '"*"';
      if (f & ts.TypeFlags.Boolean) return '"b"';
      if (f & ts.TypeFlags.Number) return '"n"';
      if (f & ts.TypeFlags.String) return '"s"';
      if (f & ts.TypeFlags.Null) return '"z"';
      if (f & ts.TypeFlags.StringLiteral) return lit((t as ts.StringLiteralType).value);
      if (f & ts.TypeFlags.NumberLiteral) return lit((t as ts.NumberLiteralType).value);
      if (f & ts.TypeFlags.BooleanLiteral) return lit(isTrue(t));
      if (f & ts.TypeFlags.Union) {
        const members = (t as ts.UnionType).types.filter((m) => !(m.flags & ts.TypeFlags.Undefined));
        const bools = members.filter((m) => m.flags & ts.TypeFlags.BooleanLiteral);
        const both = bools.length === 2;
        const parts: string[] = [];
        let boolDone = false;
        for (const m of members) {
          if (both && (m.flags & ts.TypeFlags.BooleanLiteral)) {
            if (!boolDone) { parts.push('"b"'); boolDone = true; }
            continue;
          }
          parts.push(schema(m));
        }
        if (parts.length === 0) return fail("undefined");
        if (parts.length === 1) return parts[0];
        return `{"k":"u","m":[${parts.join(",")}]}`;
      }
      if (f & ts.TypeFlags.Enum) return '"n"'; // an enum with computed members: its values are numbers
      if (f & ts.TypeFlags.Object || f & ts.TypeFlags.Intersection) {
        if (f & ts.TypeFlags.Object) {
          if (checker.isArrayType(t)) {
            const args = checker.getTypeArguments(t as ts.TypeReference);
            return `{"k":"a","e":${args.length ? schema(args[0]) : '"*"'}}`;
          }
          if (checker.isTupleType(t)) {
            const target = (t as ts.TupleTypeReference).target;
            if (!target.elementFlags.every((e) => e & ts.ElementFlags.Required)) return fail("a tuple with optional or rest elements");
            return `{"k":"t","e":[${checker.getTypeArguments(t as ts.TypeReference).map(schema).join(",")}]}`;
          }
        }
        if (t.symbol && (t.symbol.flags & ts.SymbolFlags.Class)) return fail(`a class (${t.symbol.name})`);
        if (checker.getSignaturesOfType(t, ts.SignatureKind.Call).length > 0 ||
            checker.getSignaturesOfType(t, ts.SignatureKind.Construct).length > 0) return fail("a function type");
        const id = idOf(t);
        if (visiting.has(id)) {
          if (!defNames.has(id)) defNames.set(id, nameOf(t));
          return ref(id);
        }
        if (defNames.has(id)) return ref(id); // defined by an earlier visit
        visiting.add(id);
        let body: string;
        const props = checker.getPropertiesOfType(t);
        const indexInfos = checker.getIndexInfosOfType(t);
        if (indexInfos.length > 0) {
          if (props.length > 0 || indexInfos.length !== 1 || !(indexInfos[0].keyType.flags & ts.TypeFlags.String)) {
            body = fail("an index signature beside named properties");
          } else body = `{"k":"r","e":${schema(indexInfos[0].type)}}`;
        } else {
          const entries: string[] = [];
          for (const p of props) {
            if (p.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Accessor)) { body = fail(`a method (${p.name})`); break; }
            if (p.name.startsWith("__@")) { body = fail(`a symbol-keyed property`); break; }
            const pt = checker.getTypeOfSymbolAtLocation(p, node);
            const optional = (p.flags & ts.SymbolFlags.Optional) !== 0 ||
              ((pt.flags & ts.TypeFlags.Union) !== 0 && (pt as ts.UnionType).types.some((m) => (m.flags & ts.TypeFlags.Undefined) !== 0));
            entries.push(`[${JSON.stringify(p.name)},${schema(pt)},${optional ? 1 : 0}]`);
          }
          body = failure !== undefined ? '"*"' : `{"k":"o","p":[${entries.join(",")}]}`;
        }
        visiting.delete(id);
        if (defNames.has(id)) { defs.push(`${JSON.stringify(defNames.get(id))}:${body}`); return ref(id); }
        return body;
      }
      return fail(checker.typeToString(t));
    };
    const s = schema(root);
    if (failure !== undefined) {
      this.unsupported(node, `typed JSON cannot represent ${failure} in ${checker.typeToString(root)}`);
      return undefined;
    }
    return defs.length ? `{"d":{${defs.join(",")}},"s":${s}}` : `{"s":${s}}`;
  }

  /** `parse(text, "<schema>")`: a direct call of garnet:json's parse. */
  private lowerTypedJsonParse(ctx: FnCtx, node: ts.CallExpression, tj: { func: number; schema: string }): number {
    const text = this.lowerExpr(ctx, node.arguments[0]);
    const sch = this.newLocal(ctx, "reference", "json.schema");
    ctx.body.push({ kind: "Const", dst: sch, value: { kind: "Str", value: tj.schema } });
    const dst = this.newLocal(ctx, this.refKindOf(node));
    const args = [text, sch];
    const cells = this.directCallCellArgs(ctx, tj.func);
    if (cells.length) args.unshift(...cells);
    ctx.body.push({ kind: "Call", dst, callee: { kind: "Direct", func: tj.func }, args });
    return dst;
  }

  // ---- JSX (docs/jsx_react_ssr_design.md) --------------------------------------------------------
  // The preserved JSX nodes are lowered to what TypeScript's two transforms emit. The classic transform
  // calls the factory (`React.createElement` through a namespace import, or the `jsxFactory` option /
  // `@jsx` pragma) with the props (`null` without attributes) and the children as arguments; the
  // automatic runtime (`jsx: react-jsx`, `jsxImportSource`, the `@jsxImportSource` pragma) calls `jsx`
  // or `jsxs` of `<source>/jsx-runtime` with the children in the props and the key as the third
  // argument, and `Fragment` of it as the fragment's type. A bundled factory is called directly.

  /** True if `sf` has a JSX element (its module then depends on the JSX runtime module). */
  private fileHasJsx(sf: ts.SourceFile): boolean {
    if (sf.languageVariant !== ts.LanguageVariant.JSX) return false;
    let has = this.jsxFiles.get(sf);
    if (has === undefined) {
      has = false;
      const visit = (n: ts.Node): void => {
        if (has) return;
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) { has = true; return; }
        n.forEachChild(visit);
      };
      visit(sf);
      this.jsxFiles.set(sf, has);
    }
    return has;
  }

  /** The automatic runtime's module for the JSX in `sf`: `<jsxImportSource>/jsx-runtime`, the synthetic
   *  import the program resolved for the file; undefined under the classic transform. */
  private jsxRuntimeModuleOf(sf: ts.SourceFile): ts.SourceFile | undefined {
    if (this.jsxRuntimeModules.has(sf)) return this.jsxRuntimeModules.get(sf);
    let found: ts.SourceFile | undefined;
    const spec = jsxRuntimeImportOf(this.program.getCompilerOptions(), sf);
    if (spec !== undefined) {
      const imports = (sf as unknown as { imports?: readonly ts.StringLiteralLike[] }).imports ?? [];
      const lit = imports.find((i) => i.text === spec);
      found = lit ? this.resolveModuleSf(lit) : undefined;
      if (!found) this.unsupported(sf, `the JSX runtime module "${spec}" (jsxImportSource) is not in the program`);
    }
    this.jsxRuntimeModules.set(sf, found);
    return found;
  }

  /** The exports of a runtime module the JSX calls. */
  private jsxRuntimeExportsOf(rt: ts.SourceFile): JsxRuntimeExports {
    let ex = this.jsxRuntimeExports.get(rt);
    if (!ex) {
      const moduleSymbol = this.checker.getSymbolAtLocation(rt) ?? (rt as unknown as { symbol?: ts.Symbol }).symbol;
      const exportOf = (name: string) => moduleSymbol && this.checker.getExportsOfModule(moduleSymbol).find((s) => s.name === name);
      ex = { jsx: exportOf("jsx"), jsxs: exportOf("jsxs"), fragment: exportOf("Fragment") };
      this.jsxRuntimeExports.set(rt, ex);
    }
    return ex;
  }

  /** The runtime functions a JSX element or fragment uses (resolved once per site: the free-variable
   *  scan and the lowering agree on them, and a missing one is reported once). */
  private jsxSiteCallees(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment): JsxSite {
    let site = this.jsxSites.get(node);
    if (site) return site;
    const rt = this.jsxRuntimeModuleOf(node.getSourceFile());
    if (rt) {
      const ex = this.jsxRuntimeExportsOf(rt);
      const isStatic = jsxStaticChildren(ts.isJsxSelfClosingElement(node) ? [] : node.children);
      site = {
        runtime: rt,
        call: this.jsxCalleeOf(isStatic ? ex.jsxs : ex.jsx, node, `${isStatic ? "jsxs" : "jsx"} of the JSX runtime`),
        value: ts.isJsxFragment(node) ? this.jsxCalleeOf(ex.fragment, node, "Fragment of the JSX runtime") : undefined,
      };
    } else {
      site = { call: this.jsxClassicOf(node, false), value: ts.isJsxFragment(node) ? this.jsxClassicOf(node, true) : undefined };
    }
    this.jsxSites.set(node, site);
    return site;
  }

  /** A binding as a JSX callee: the function it declares (an import alias unwrapped) and its name. */
  private jsxCalleeOf(sym: ts.Symbol | undefined, node: ts.Node, what: string): JsxCallee | undefined {
    const target = sym ? (this.unwrapImportAlias(sym) ?? sym) : undefined;
    const name = target && declarationNameOf(target);
    if (target && name) return { fn: this.funcSymbols.get(target), name };
    this.unsupported(node, `JSX: ${what} is not a bundled function or variable`);
    return undefined;
  }

  /** An export of a bundled module as a JSX callee: the function or binding it declares, with the
   *  namespace object `ns` (the call's receiver) as the fallback: `ns.member`. */
  private jsxModuleExportCallee(moduleSymbol: ts.Symbol, name: string, ns: ts.Identifier | undefined, node: ts.Node): JsxCallee | undefined {
    const exported = this.checker.getExportsOfModule(moduleSymbol).find((s) => s.name === name);
    if (!exported) {
      if (ns) return { ns, member: name };   // a loud run-time lookup: undefined is not a function
      this.unsupported(node, `JSX: the runtime module does not export ${name}`);
      return undefined;
    }
    const target = this.unwrapImportAlias(exported) ?? exported;
    return { fn: this.funcSymbols.get(target), name: declarationNameOf(target), ns, member: name };
  }

  /** `React.createElement` / `React.Fragment`, the default classic factory: the namespace import named
   *  React of a bundled module, and that module's export. */
  private jsxReactCallee(node: ts.Node, name: string): JsxCallee | undefined {
    const sf = node.getSourceFile();
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const bindings = stmt.importClause?.namedBindings;
      if (!bindings || !ts.isNamespaceImport(bindings) || bindings.name.text !== "React") continue;
      const target = this.resolveModuleSf(stmt.moduleSpecifier);
      if (!target) continue;
      const moduleSymbol = this.checker.getSymbolAtLocation(target) ?? (target as unknown as { symbol?: ts.Symbol }).symbol;
      if (!moduleSymbol) continue;
      return this.jsxModuleExportCallee(moduleSymbol, name, bindings.name, node);
    }
    this.unsupported(node, "JSX requires `import * as React from \"<bundled module>\"` with an exported createElement function, " +
      "a jsxFactory (the @jsx pragma), or the automatic runtime (jsxImportSource)");
    return undefined;
  }

  /** `jsxFactory` / `@jsx` text (`h`, `React.createElement`) resolved at the JSX site: a name in scope,
   *  or a namespace import's member (the module's export). */
  private jsxEntityCallee(node: ts.Node, text: string, what: string): JsxCallee | undefined {
    const parts = text.split(".");
    const first = this.checker.resolveName(parts[0], node, ts.SymbolFlags.Value, false);
    if (!first) { this.unsupported(node, `${what} ${text} is not in scope`); return undefined; }
    if (parts.length === 1) return this.jsxCalleeOf(first, node, `${what} ${text}`);
    const firstName = declarationNameOf(first);
    const nsTarget = first.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(first) : first;
    if (parts.length === 2 && firstName && nsTarget && nsTarget.declarations?.some((d) => ts.isSourceFile(d))) {
      return this.jsxModuleExportCallee(nsTarget, parts[1], firstName, node);
    }
    this.unsupported(node, `${what} ${text}: a name in scope or a namespace import's member`);
    return undefined;
  }

  /** The classic transform's factory (or, with `fragment`, fragment factory) for the file of `node`:
   *  the `@jsx` / `@jsxFrag` pragmas, the `jsxFactory` / `jsxFragmentFactory` options, or the defaults
   *  `React.createElement` / `React.Fragment`. A fragment under a factory without a fragment factory
   *  is an error, as TypeScript's (TS17016). */
  private jsxClassicOf(node: ts.Node, fragment: boolean): JsxCallee | undefined {
    const sf = node.getSourceFile();
    const options = this.program.getCompilerOptions();
    const factoryText = jsxPragmaOf(sf, "jsx") ?? options.jsxFactory;
    const fragmentText = jsxPragmaOf(sf, "jsxfrag") ?? options.jsxFragmentFactory;
    if (fragment) {
      if (fragmentText !== undefined) return this.jsxEntityCallee(node, fragmentText, "the JSX fragment factory");
      if (factoryText === undefined) return this.jsxReactCallee(node, "Fragment");
      this.unsupported(node, "a JSX fragment under a jsxFactory without a jsxFragmentFactory (the @jsxFrag pragma)");
      return undefined;
    }
    return factoryText !== undefined ? this.jsxEntityCallee(node, factoryText, "the JSX factory") : this.jsxReactCallee(node, "createElement");
  }

  /** The value of a JSX callee (a fragment's type). */
  private jsxCalleeValue(ctx: FnCtx, callee: JsxCallee | undefined): number {
    if (callee?.name) return this.lowerIdentifier(ctx, callee.name);
    const dst = this.newLocal(ctx, "reference", callee?.member);
    if (callee?.ns) {
      const recv = this.lowerIdentifier(ctx, callee.ns);
      ctx.body.push({ kind: "LoadField", dst, obj: recv, field: this.internField(callee.member!) });
    } else ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
    return dst;
  }

  /** The call of a JSX factory or runtime function: direct when the function is bundled and does not
   *  use `this`; through the namespace object (its `this`) or the binding's value otherwise. A spread
   *  child (the classic transform's `...children` arguments) makes it a spread call. */
  private emitJsxCall(ctx: FnCtx, callee: JsxCallee | undefined, args: JsxArg[]): number {
    const dst = this.newLocal(ctx, "reference", "jsx");
    if (!callee) return dst;
    const spread = args.some((a) => a.kind === "spread");
    const fn = callee.fn;
    if (fn !== undefined && !this.funcTakesThisIds.has(fn)) {
      const cells: JsxArg[] = this.directCallCellArgs(ctx, fn).map((c) => ({ kind: "single", local: c }));
      if (spread) ctx.body.push({ kind: "CallSpread", dst, callee: { kind: "Direct", func: fn }, argSpecs: [...cells, ...args] });
      else ctx.body.push({ kind: "Call", dst, callee: { kind: "Direct", func: fn }, args: [...cells, ...args].map((a) => a.local) });
      return dst;
    }
    let recv: number | undefined;
    let value: number;
    if (callee.ns) {
      recv = this.lowerIdentifier(ctx, callee.ns);
      value = this.newLocal(ctx, "reference", callee.member);
      ctx.body.push({ kind: "LoadField", dst: value, obj: recv, field: this.internField(callee.member!) });
    } else {
      value = this.lowerIdentifier(ctx, callee.name!);
    }
    const inst: any = spread ? { kind: "CallSpread", dst, callee: { kind: "Value", local: value }, argSpecs: args }
                             : { kind: "Call", dst, callee: { kind: "Value", local: value }, args: args.map((a) => a.local) };
    if (recv !== undefined) inst.recv = recv;
    ctx.body.push(inst);
    return dst;
  }

  /** `&name;` / `&#n;` / `&#xh;` in JSX text and string attributes, decoded as TypeScript does (its
   *  table of named references; an unknown name stays as written). */
  private decodeJsxEntities(raw: string, node: ts.Node): string {
    return raw.replace(/&((#((\d+)|x([\da-fA-F]+)))|(\w+));/g,
      (match, _all: string, _number: string, _digits: string,
       decimal: string, hex: string, word: string) => {
        if (decimal || hex) {
          const cp = parseInt(decimal || hex, decimal ? 10 : 16);
          if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) return String.fromCodePoint(cp);
          this.unsupported(node, `invalid JSX character reference ${match}`);
          return match;
        }
        const cp = Object.prototype.hasOwnProperty.call(JSX_ENTITIES, word) ? JSX_ENTITIES[word] : undefined;
        return cp === undefined ? match : String.fromCodePoint(cp);
      });
  }

  private jsxTextValue(raw: string, node: ts.Node): string {
    let acc: string | undefined;
    let firstNonWhitespace = 0;
    let lastNonWhitespace = -1;
    const isLineBreak = (c: number) => c === 10 || c === 13 || c === 8232 || c === 8233;
    const isWhiteSpaceSingleLine = (c: number) =>
      c === 32 || c === 9 || c === 11 || c === 12 || c === 160 || c === 133 ||
      c === 5760 || (c >= 8192 && c <= 8203) || c === 8239 || c === 8287 ||
      c === 12288 || c === 65279;
    const addLine = (text: string) => {
      const decoded = this.decodeJsxEntities(text, node);
      acc = acc === undefined ? decoded : `${acc} ${decoded}`;
    };
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (isLineBreak(c)) {
        if (firstNonWhitespace !== -1 && lastNonWhitespace !== -1) {
          addLine(raw.substring(firstNonWhitespace, lastNonWhitespace + 1));
        }
        firstNonWhitespace = -1;
      } else if (!isWhiteSpaceSingleLine(c)) {
        lastNonWhitespace = i;
        if (firstNonWhitespace === -1) firstNonWhitespace = i;
      }
    }
    if (firstNonWhitespace !== -1) addLine(raw.substring(firstNonWhitespace));
    return acc ?? "";
  }

  private lowerJsxTag(ctx: FnCtx, node: ts.JsxOpeningLikeElement): number {
    const tag = node.tagName;
    if (ts.isIdentifier(tag)) {
      const text = tag.text;
      const first = text.charCodeAt(0);
      if ((first >= 97 && first <= 122) || text.includes("-")) {
        const dst = this.newLocal(ctx, "reference", "jsx.tag");
        ctx.body.push({ kind: "Const", dst, value: { kind: "Str", value: text } });
        return dst;
      }
      return this.lowerIdentifier(ctx, tag);
    }
    if (ts.isJsxNamespacedName(tag)) {   // `<svg:path>`: a string tag
      const dst = this.newLocal(ctx, "reference", "jsx.tag");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Str", value: `${tag.namespace.text}:${tag.name.text}` } });
      return dst;
    }
    if (ts.isPropertyAccessExpression(tag)) return this.lowerExpr(ctx, tag);
    if (tag.kind === ts.SyntaxKind.ThisKeyword) return this.lowerExpr(ctx, tag as ts.Expression);
    this.unsupported(tag, `JSX tag ${ts.SyntaxKind[(tag as ts.Node).kind]}`);
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
    return dst;
  }

  /** The value of an attribute: present without an initializer is `true`; a string literal decodes its
   *  entities; `{expr}` is the expression (an empty `{}` is an error); a JSX element as is. */
  private lowerJsxAttributeValue(ctx: FnCtx, attr: ts.JsxAttribute): number | undefined {
    if (!attr.initializer) {
      const value = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst: value, value: { kind: "Bool", value: true } });
      return value;
    }
    if (ts.isStringLiteral(attr.initializer)) {
      const value = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: value,
        value: { kind: "Str", value: this.decodeJsxEntities(attr.initializer.text, attr.initializer) } });
      return value;
    }
    if (ts.isJsxExpression(attr.initializer)) {
      if (!attr.initializer.expression) { this.unsupported(attr, "empty JSX attribute expression"); return undefined; }
      return this.lowerExpr(ctx, attr.initializer.expression);
    }
    return this.lowerExpr(ctx, attr.initializer as ts.Expression);
  }

  /** The props object: the attributes in order (`{...spread}` copies, `key` skipped under the automatic
   *  runtime, where it is the call's third argument), then, with `children` given (the automatic
   *  runtime), the `children` property: one child as is, several or a spread child as an array. */
  private lowerJsxProps(ctx: FnCtx, at: ts.Node, node: ts.JsxOpeningLikeElement | undefined, key: ts.JsxAttribute | undefined,
                        children: readonly ts.JsxChild[] | undefined): number {
    const site = this.site++;
    const dst = this.newLocal(ctx, "reference", "jsx.props");
    const attrs = node ? node.attributes.properties : [];
    const hasSpread = attrs.some((p) => ts.isJsxSpreadAttribute(p));
    this.labels[site] = `${node ? "jsx-props" : "jsx-fragment-props"}@${ctx.name}`;
    this.recordSite(site, "object", this.inLoop(at) ? "many" : "once", !hasSpread, at);
    ctx.body.push({ kind: "AllocObject", dst, typeId: 0, site });
    for (const attr of attrs) {
      if (attr === key) continue;
      if (ts.isJsxSpreadAttribute(attr)) {
        const src = this.lowerExpr(ctx, attr.expression);
        ctx.body.push({ kind: "ObjectCopyProps", dst, src });
        continue;
      }
      const value = this.lowerJsxAttributeValue(ctx, attr);
      if (value === undefined) continue;
      ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField(jsxAttributeName(attr)), src: value });
    }
    if (children !== undefined) {
      const semantic = children.filter(isSemanticJsxChild);
      if (semantic.length === 1 && !(ts.isJsxExpression(semantic[0]) && semantic[0].dotDotDotToken)) {
        const [one] = this.lowerJsxChildren(ctx, semantic);
        if (one) ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField("children"), src: one.local });
      } else if (semantic.length > 0) {
        const arr = this.jsxChildrenArray(ctx, at, this.lowerJsxChildren(ctx, children));
        ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField("children"), src: arr });
      }
    }
    return dst;
  }

  /** The children as an array (the automatic runtime's `children: [...]`). */
  private jsxChildrenArray(ctx: FnCtx, at: ts.Node, items: JsxArg[]): number {
    const site = this.site++;
    this.recordSite(site, "array", this.inLoop(at) ? "many" : "once", false, at);
    const arr = this.newLocal(ctx, "reference", "jsx.children");
    ctx.body.push({ kind: "AllocArray", dst: arr, elemType: 0, site });
    for (const item of items) {
      if (item.kind === "spread") ctx.body.push({ kind: "ArrayPushAll", arr, src: item.local });
      else ctx.body.push({ kind: "ArrayPush", arr, src: item.local });
    }
    return arr;
  }

  /** The children in order: text (whitespace-normalized, entities decoded; whitespace-only text and
   *  empty `{}` dropped), expressions, elements; `{...xs}` as the elements of the iterable, taken now
   *  (a later child may change the array). */
  private lowerJsxChildren(ctx: FnCtx, children: readonly ts.JsxChild[]): JsxArg[] {
    const out: JsxArg[] = [];
    for (const child of children) {
      if (ts.isJsxText(child)) {
        const text = this.jsxTextValue(child.text, child);
        if (text.length === 0) continue;
        const local = this.newLocal(ctx, "reference", "jsx.text");
        ctx.body.push({ kind: "Const", dst: local, value: { kind: "Str", value: text } });
        out.push({ kind: "single", local });
        continue;
      }
      let value: number;
      if (ts.isJsxExpression(child)) {
        if (!child.expression) continue; // a JSX comment / empty expression
        value = this.lowerExpr(ctx, child.expression);
        if (child.dotDotDotToken) {
          const site = this.site++;
          this.recordSite(site, "array", this.inLoop(child) ? "many" : "once", false, child);
          const local = this.newLocal(ctx, "reference", "jsx.spread");
          ctx.body.push({ kind: "AllocArray", dst: local, elemType: 0, site });
          ctx.body.push({ kind: "ArrayPushAll", arr: local, src: value });
          out.push({ kind: "spread", local });
          continue;
        }
      } else {
        value = this.lowerExpr(ctx, child as ts.Expression);
      }
      if (this.isMutableStorageLocal(ctx, value)) {   // a later child may assign the binding
        const snapshot = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Copy", dst: snapshot, src: value });
        value = snapshot;
      }
      out.push({ kind: "single", local: value });
    }
    return out;
  }

  private lowerJsxElement(ctx: FnCtx, node: ts.JsxElement | ts.JsxSelfClosingElement): number {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const childNodes = ts.isJsxElement(node) ? node.children : undefined;
    const site = this.jsxSiteCallees(node);
    if (site.runtime) {
      if (jsxKeyAfterSpread(opening)) {
        // TypeScript calls `createElement` of the import source here; not modelled
        this.unsupported(opening, "a JSX key attribute after a spread attribute under the automatic runtime");
        return this.emitJsxCall(ctx, undefined, []);
      }
      const type = this.lowerJsxTag(ctx, opening);
      const key = opening.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "key");
      const props = this.lowerJsxProps(ctx, node, opening, key, childNodes ?? []);
      const args: JsxArg[] = [{ kind: "single", local: type }, { kind: "single", local: props }];
      if (key) {
        const k = this.lowerJsxAttributeValue(ctx, key);
        if (k !== undefined) args.push({ kind: "single", local: k });
      }
      return this.emitJsxCall(ctx, site.call, args);
    }
    const type = this.lowerJsxTag(ctx, opening);
    let props: number;
    if (opening.attributes.properties.length > 0) props = this.lowerJsxProps(ctx, node, opening, undefined, undefined);
    else {   // the classic transform passes null without attributes
      props = this.newLocal(ctx, "reference", "jsx.props");
      ctx.body.push({ kind: "Const", dst: props, value: { kind: "Null" } });
    }
    const children = childNodes ? this.lowerJsxChildren(ctx, childNodes) : [];
    return this.emitJsxCall(ctx, site.call, [{ kind: "single", local: type }, { kind: "single", local: props }, ...children]);
  }

  /** `import(spec)` of a module the program does not bundle (hono's `await import("cloudflare:workers")`
   *  behind a runtime check, in a try/catch): a promise rejected with an Error naming the module, as Node
   *  rejects a module it cannot load, so the program compiles and the catch runs. The specifier must have
   *  a string literal type (a literal, or a const of one); one that resolves to a module stays a
   *  compile-time reject (the module would be bundled and evaluated at startup, not loaded lazily). */
  private lowerDynamicImport(ctx: FnCtx, node: ts.CallExpression): number {
    const arg = node.arguments[0];
    const t = arg ? this.checker.getTypeAtLocation(arg) : undefined;
    const spec = t && (t.flags & ts.TypeFlags.StringLiteral) ? (t as ts.StringLiteralType).value : undefined;
    const dst = this.newLocal(ctx, "reference", "import");
    if (spec === undefined) {
      this.unsupported(node, "a dynamic import() whose specifier is not a string literal (or a const of one)");
      return dst;
    }
    const resolved = ts.resolveModuleName(spec, node.getSourceFile().fileName, this.program.getCompilerOptions(), ts.sys).resolvedModule;
    if (resolved) {
      this.unsupported(node, `a dynamic import() of a module the program bundles (${spec}): a static import is its compiled form`);
      return dst;
    }
    if (arg) this.lowerExpr(ctx, arg);   // the specifier expression's own effects
    const msg = this.constString(ctx, `Cannot find module '${spec}': a dynamic import of a module the program does not bundle`);
    const err = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst: err, builtin: `error.new:${this.errorKindIndex("Error")}`, args: [msg] });
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "promise.reject", args: [err] });
    return dst;
  }

  private lowerJsxFragment(ctx: FnCtx, node: ts.JsxFragment): number {
    const site = this.jsxSiteCallees(node);
    const type = this.jsxCalleeValue(ctx, site.value);
    if (site.runtime) {
      const props = this.lowerJsxProps(ctx, node, undefined, undefined, node.children);
      return this.emitJsxCall(ctx, site.call, [{ kind: "single", local: type }, { kind: "single", local: props }]);
    }
    const props = this.newLocal(ctx, "reference", "jsx.fragment.props");
    ctx.body.push({ kind: "Const", dst: props, value: { kind: "Null" } });
    const children = this.lowerJsxChildren(ctx, node.children);
    return this.emitJsxCall(ctx, site.call, [{ kind: "single", local: type }, { kind: "single", local: props }, ...children]);
  }

  private lowerTaggedTemplate(ctx: FnCtx, node: ts.TaggedTemplateExpression): number {
    const tag = this.unwrapExpr(node.tag);
    let recv: number | undefined;
    let callee: number;
    if (ts.isPropertyAccessExpression(tag)) {
      recv = this.lowerExpr(ctx, tag.expression);
      if (this.isMutableStorageLocal(ctx, recv)) {
        const snapshot = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Copy", dst: snapshot, src: recv });
        recv = snapshot;
      }
      const saved = this.optChainBound.get(tag.expression);
      this.optChainBound.set(tag.expression, recv);
      try { callee = this.lowerExpr(ctx, tag); }
      finally {
        if (saved === undefined) this.optChainBound.delete(tag.expression);
        else this.optChainBound.set(tag.expression, saved);
      }
    } else if (ts.isElementAccessExpression(tag)) {
      const [base, key] = this.lowerSequenced(ctx, [tag.expression, tag.argumentExpression]);
      recv = base;
      callee = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadFieldDynamic", dst: callee, obj: base, key });
    } else {
      callee = this.lowerExpr(ctx, node.tag);
      if (this.isMutableStorageLocal(ctx, callee)) {
        const snapshot = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Copy", dst: snapshot, src: callee });
        callee = snapshot;
      }
    }
    let global = this.templateObjectGlobals.get(node);
    if (global === undefined) {
      global = this.internGlobal(`__template_${this.templateObjectGlobals.size}`);
      this.templateObjectGlobals.set(node, global);
    }
    const template = this.newLocal(ctx, "reference", "templateObject");
    ctx.body.push({ kind: "LoadGlobal", dst: template, gref: global });
    const undefinedValue = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: undefinedValue, value: { kind: "Undef" } });
    const missing = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "BinOp", dst: missing, op: "===", lhs: template, rhs: undefinedValue });
    const literals = ts.isTemplateExpression(node.template)
      ? [node.template.head, ...node.template.templateSpans.map(span => span.literal)] : [node.template];
    const initialize = this.captureBody(ctx, () => {
      const raw = this.newLocal(ctx, "reference", "templateRaw");
      for (const dst of [template, raw]) {
        const site = this.site++;
        this.recordSite(site, "array", "once", false, node);
        ctx.body.push({ kind: "AllocArray", dst, elemType: 0, site });
      }
      for (const literal of literals) {
        const flags = (literal as unknown as { templateFlags?: number }).templateFlags ?? 0;
        const invalid = (flags & (ts as any).TokenFlags.ContainsInvalidEscape) !== 0;
        const cooked = invalid ? undefinedValue : this.constString(ctx, literal.text);
        const rawText = this.constString(ctx, literal.rawText ?? literal.text);
        ctx.body.push({ kind: "ArrayPush", arr: template, src: cooked });
        ctx.body.push({ kind: "ArrayPush", arr: raw, src: rawText });
      }
      this.defineDataField(ctx, template, "raw", raw, 0, 0, 0);
      for (const value of [raw, template]) ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "object.freeze", args: [value] });
      ctx.body.push({ kind: "StoreGlobal", gref: global!, src: template });
    });
    ctx.body.push({ kind: "If", cond: missing, thenBody: initialize, elseBody: [] });
    const expressions = ts.isTemplateExpression(node.template) ? node.template.templateSpans.map(span => span.expression) : [];
    const args = [template, ...this.lowerSequenced(ctx, expressions)];
    const dst = this.newLocal(ctx, this.refKindOf(node));
    const call: any = { kind: "Call", dst, callee: { kind: "Value", local: callee }, args };
    if (recv !== undefined) call.recv = recv;
    ctx.body.push(call);
    return dst;
  }

  /** A class method read as a value here (class_extract.ts pass 5): note it
   *  at run time, before the read, so typed accesses test the class interval
   *  from then on (docs/closed_receivers_design.md, slice 2). */
  noteMethodEscape(ctx: FnCtx, node: ts.Node): void {
    // (TSAOT_METHOD_ESCAPES=0: the frozen emitter's IR, without the notes)
    if (process.env.TSAOT_METHOD_ESCAPES === "0" || !this.classExtractor?.methodEscapes.has(node)) return;
    ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "class.methodEscape", args: [] });
  }
  lowerExpr(ctx: FnCtx, node: ts.Expression, hint?: string): number {
    // Optional-chaining: a guard receiver whose value was already computed once
    // returns its memoized local (no re-evaluation, preserving side effects).
    const bound = this.optChainBound.get(node);
    if (bound !== undefined) return bound;
    this.noteMethodEscape(ctx, node);
    if (ts.isTaggedTemplateExpression(node)) return this.lowerTaggedTemplate(ctx, node);
    const jcv = this.constJsonNumberValue(node);
    if (jcv !== undefined && jcv.usedJson && Number.isFinite(jcv.value)) {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: Object.is(jcv.value, -0) ? { kind: "NegZero" } : { kind: "Num", value: this.numWire(jcv.value) } });
      return dst;
    }
    // Negative-zero constant folding: a fully-constant numeric expression whose JS
    // value is -0 (e.g. `0 * -1`, `-4 % 2`, `0 / -1`, the `-0` literal) is emitted as
    // a NegZero const, so the sign survives instead of being flattened by the int
    // specialization. ONLY -0 is folded — other constant results are left to normal
    // lowering (no general folding, so no NaN/Inf tag-mapping risk). Constant exprs
    // have no side effects, so skipping operand lowering here is safe; a non-constant
    // operand (e.g. `0 * y`, `-z`) makes constNumValue undefined and we fall through.
    if (ts.isBinaryExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isParenthesizedExpression(node)) {
      const cv = this.constNumValue(node);
      if (cv !== undefined && Object.is(cv, -0)) {
        const dst = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst, value: { kind: "NegZero" } });
        return dst;
      }
    }
    // The outermost `?.` link drives the whole chain's short-circuit (unless we
    // are already inside it computing the un-short-circuited value).
    if (!this.optChainSkip.has(node) && this.isOptionalChainRoot(node)) {
      return this.lowerOptionalChain(ctx, node);
    }
    if (ts.isParenthesizedExpression(node)) return this.lowerExpr(ctx, node.expression, hint);
    if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) return this.lowerExpr(ctx, node.expression, hint);
    // Type-only wrappers that erase to their operand: `<T>x` (angle-bracket
    // assertion) and `x satisfies T`. Same erasure as `x as T`.
    if (ts.isTypeAssertionExpression(node)) return this.lowerExpr(ctx, node.expression, hint);
    if ((ts as any).isSatisfiesExpression?.(node)) return this.lowerExpr(ctx, (node as any).expression, hint);
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) return this.lowerJsxElement(ctx, node);
    if (ts.isJsxFragment(node)) return this.lowerJsxFragment(ctx, node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return this.lowerDynamicImport(ctx, node);
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const lowered = this.lowerRegExpLiteralObject(ctx, node, node.getText(), hint);
      if (lowered !== undefined) return lowered;
      this.unsupported(node, "RegExp literal has invalid flags");
      const dst = this.newLocal(ctx, "reference", hint);
      ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
      return dst;
    }

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return this.lowerClosure(ctx, node, hint);
    }
    if (ts.isClassExpression(node)) {
      return this.lowerClassExpressionValue(ctx, node, hint);
    }
    // `new <expr>()` where the result type is a union of known classes — a
    // polymorphic class value (`const K = cond ? A : B; new K()`, or directly
    // `new (cond ? A : B)()`). Construct dynamically on the runtime value's class_id;
    // the union result type keeps downstream access dynamic (sound). Runs BEFORE the
    // identifier gate below so it handles non-identifier callees too.
    if (ts.isNewExpression(node)) {
      const poly = this.lowerPolymorphicNew(ctx, node, hint);
      if (poly !== undefined) return poly;
    }
    // `new C(...spread)` for ANY callee (identifier class, constructor-typed
    // variable, or parenthesized `new (ctor)(...args)`): spread args can't be
    // passed positionally to the C constructor, so materialize an argument array
    // and construct dynamically via ts_construct (reflect.construct). That runs a
    // class value's ctor, a plain function's [[Construct]], or a proxy trap, and
    // throws a catchable TypeError for a non-constructor — matching JS.
    if (ts.isNewExpression(node) && node.arguments && Array.from(node.arguments).some((a) => ts.isSpreadElement(a))
        && !this.isAmbientGlobalSymbol(this.symbolOf(node.expression))) {
      const args = Array.from(node.arguments);
      const callee = this.lowerExpr(ctx, node.expression);
      const site = this.site++;
      this.recordSite(site, "array", this.inLoop(node) ? "many" : "once", false, node);
      const arrL = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "AllocArray", dst: arrL, elemType: 0, site });
      for (const a of args) {
        if (ts.isSpreadElement(a)) ctx.body.push({ kind: "ArrayPushAll", arr: arrL, src: this.lowerExpr(ctx, a.expression) });
        else ctx.body.push({ kind: "ArrayPush", arr: arrL, src: this.lowerExpr(ctx, a) });
      }
      const ddst = this.newLocal(ctx, "reference", hint);
      ctx.body.push({ kind: "CallBuiltinStatic", dst: ddst, builtin: "reflect.construct", args: [callee, arrL] });
      return ddst;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const ctorName = node.expression.text;
      // Built-in constructors (Map/Set/Array/Date/Error family/Promise) lower to
      // runtime containers / tagged objects; returns undefined for a user class.
      // Built-in names are ordinary identifiers: only treat `new X()` as a built-in
      // when X resolves to the genuine ambient builtin (all decls in .d.ts). A user
      // binding shadowing the name (`class Map {}`, `class Error {}`) is NOT a builtin
      // — fall through so resolveNewTarget constructs the user class. (No symbol =>
      // ambient, matching isBuiltinNamespaceRef's defensive default.)
      const csym = this.symbolOf(node.expression);
      if (this.isAmbientGlobalSymbol(csym)) {
        const builtinNew = this.lowerNewBuiltin(ctx, node, ctorName, hint);
        if (builtinNew !== undefined) return builtinNew;
        if (ctorName === "RegExp") {
          this.unsupported(node, "new RegExp(...) requires a const string pattern and const string flags");
          return this.newLocal(ctx, "reference", hint);
        }
      }
      // `new x()` where x is `any`-typed (e.g. a Proxy with a construct trap, or a
      // function/class value held in `any`): construct dynamically via ts_construct,
      // which dispatches the proxy [[Construct]] trap, runs a class value's ctor, or
      // throws a catchable TypeError for a non-constructor. Only for `any` — typed
      // callees still classify statically through resolveNewTarget below.
      try {
        const ct = this.checker.getTypeAtLocation(node.expression);
        if ((ct.flags & ts.TypeFlags.Any) !== 0) {
          const args = node.arguments ? Array.from(node.arguments) : [];
          const callee = this.lowerExpr(ctx, node.expression);
          const ddst = this.newLocal(ctx, "reference", hint);
          if (args.some((a) => ts.isSpreadElement(a))) {
            // `new x(...spread)`: materialize an argument array and construct via
            // ts_reflect_construct (spreads array-likes/iterables like a call).
            const site = this.site++;
            this.recordSite(site, "array", this.inLoop(node) ? "many" : "once", false, node);
            const arrL = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "AllocArray", dst: arrL, elemType: 0, site });
            for (const a of args) {
              if (ts.isSpreadElement(a)) ctx.body.push({ kind: "ArrayPushAll", arr: arrL, src: this.lowerExpr(ctx, a.expression) });
              else ctx.body.push({ kind: "ArrayPush", arr: arrL, src: this.lowerExpr(ctx, a) });
            }
            ctx.body.push({ kind: "CallBuiltinStatic", dst: ddst, builtin: "reflect.construct", args: [callee, arrL] });
          } else {
            const dargs = this.lowerSequenced(ctx, args);
            this.emitNewMaybeGuarded(ctx, node, ddst, callee, dargs);
          }
          return ddst;
        }
      } catch { /* fall through to static classification */ }
      // new C(...) / new K() (class value): classify the target — resolving the
      // classId and applying generic specialization + RTA field-type recording as a
      // side effect, in the original order — then dispatch on the resulting kind.
      const target = this.resolveNewTarget(node);
      if (target.kind === "valueDynamic" || target.kind === "functionValue") {
        // valueDynamic: monomorphic class value with an explicit ctor — construct
        // via the runtime class value K (carries captured cells for a factory);
        // the static classId equals the runtime class, so downstream
        // devirtualization agrees. functionValue: an ES5 function constructor —
        // ts_construct's class_id==0 arm builds the instance on fn.prototype.
        // `new String(v)`: the prelude's wrapper class (docs/web_fetch_api_design.md), not the
        // String function the identifier names as a value
        const callee = target.kind === "functionValue" && nodePreludeFile !== undefined && ts.isIdentifier(node.expression) &&
            node.expression.text === "String" && this.isAmbientGlobalSymbol(this.symbolOf(node.expression))
          ? this.loadGlobalObjectProperty(ctx, "__garnet_StringObject")
          : this.lowerExpr(ctx, node.expression);
        const dargs = this.lowerSequenced(ctx, node.arguments ?? []);
        const ddst = this.newLocal(ctx, "reference", hint);
        this.emitNewMaybeGuarded(ctx, node, ddst, callee, dargs);
        return ddst;
      }
      // Fallback before loud-reject: the callee may be a constructable VALUE whose
      // class isn't statically resolvable — e.g. a class expression typed via a
      // construct-signature interface (`const K: Newable = class {...}`). If its
      // static type carries a construct signature, build it dynamically through
      // ts_construct on the class value (which holds the real class_id at runtime).
      if (target.kind === "reject" || (target.kind === "staticClass" && target.classId === undefined)) {
        try {
          // Only for a user-defined constructable VALUE — never an ambient builtin.
          const ambient = this.isAmbientGlobalSymbol(this.symbolOf(node.expression));
          const ct = this.checker.getTypeAtLocation(node.expression);
          if (!ambient && ct.getConstructSignatures && ct.getConstructSignatures().length > 0) {
            const callee = this.lowerExpr(ctx, node.expression);
            const dargs = this.lowerSequenced(ctx, node.arguments ?? []);
            const ddst = this.newLocal(ctx, "reference", hint);
            this.emitNewMaybeGuarded(ctx, node, ddst, callee, dargs);
            return ddst;
          }
        } catch { /* fall through to loud-reject */ }
      }
      if (target.kind === "reject") {
        this.unsupported(node, target.reason);
        return this.newLocal(ctx, "reference", hint);
      }
      // staticClass: allocate the object + run the ctor / implicit construction.
      // (classId may be undefined -> the non-class loud-reject lives in the helper.)
      return this.lowerNewStaticClass(ctx, node, target.classId, hint);
    }
    // Arbitrary constructor expressions retain their runtime class/function
    // value. ts_construct enforces constructability for any/untyped inputs.
    if (ts.isNewExpression(node)) {
      const args = node.arguments ? Array.from(node.arguments) : [];
      const callee = this.lowerExpr(ctx, node.expression);
      const ddst = this.newLocal(ctx, "reference", hint);
      if (args.some((a) => ts.isSpreadElement(a))) {
        const site = this.site++;
        this.recordSite(site, "array", this.inLoop(node) ? "many" : "once", false, node);
        const arrL = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "AllocArray", dst: arrL, elemType: 0, site });
        for (const a of args) {
          if (ts.isSpreadElement(a)) ctx.body.push({ kind: "ArrayPushAll", arr: arrL, src: this.lowerExpr(ctx, a.expression) });
          else ctx.body.push({ kind: "ArrayPush", arr: arrL, src: this.lowerExpr(ctx, a) });
        }
        ctx.body.push({ kind: "CallBuiltinStatic", dst: ddst, builtin: "reflect.construct", args: [callee, arrL] });
      } else {
        const dargs = this.lowerSequenced(ctx, args);
        this.emitNewMaybeGuarded(ctx, node, ddst, callee, dargs);
      }
      return ddst;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const site = this.site++;
      const dst = this.newLocal(ctx, "reference", hint);
      this.labels[site] = `${hint ?? "obj"}@${ctx.name}`;
      this.recordSite(site, "object", this.inLoop(node) ? "many" : "once", this.determinableObject(node), node);
      ctx.body.push({ kind: "AllocObject", dst, typeId: 0, site });
      // Pre-scan accessor members so a get/set PAIR for the same property name
      // becomes a single accessor (JS: `{ get x(){}, set x(v){} }` is one property
      // with both). Map name -> {get?, set?}. Non-accessor members are lowered in
      // declaration order in the main loop below; each accessor name is emitted
      // once, at the position of its FIRST occurrence (preserves insertion order).
      const accPairs = new Map<string, { get?: ts.AccessorDeclaration; set?: ts.AccessorDeclaration; firstIdx: number }>();
      node.properties.forEach((p, i) => {
        if ((ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.body &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          const nm = p.name.text;
          let e = accPairs.get(nm);
          if (!e) { e = { firstIdx: i }; accPairs.set(nm, e); }
          if (ts.isGetAccessorDeclaration(p)) e.get = p; else e.set = p;
        }
      });
      const emittedAcc = new Set<string>();
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "__proto__") {
          // `{ __proto__: v }` sets the prototype (an object or null; any other value is ignored), as
          // in JS; the shorthand and computed forms make an own property and take the branches below.
          const v = this.lowerExpr(ctx, p.initializer);
          ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "object.literalProto", args: [dst, v] });
          continue;
        }
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          const v = this.lowerExpr(ctx, p.initializer);
          ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField(p.name.text), src: v });
        } else if (ts.isPropertyAssignment(p) && ts.isNumericLiteral(p.name)) {
          // numeric key (e.g. `{ 0: "a" }`) -> its string form ("0"), like JS.
          const v = this.lowerExpr(ctx, p.initializer);
          ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField(String(Number(p.name.text))), src: v });
        } else if (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) {
          // { [expr]: v }. A literal computed key (string/number) is interned at
          // compile time like a normal field; a dynamic key is converted at runtime
          // via StoreFieldDynamic using JS ToPropertyKey semantics.
          const nameExpr = p.name.expression;
          if (this.isSymbolKeyExpr(nameExpr)) {
            // { [sym]: v } — symbol-keyed data property (well-known or user symbol).
            // Store under the symbol key via symbol.set (ts_set_symkey), exactly like
            // the { [Symbol.x]() {} } method form and `o[sym] = v`. Evaluate the key
            // before the value (JS computed-key order). This remains a dedicated
            // path so symbol-keyed literals do not depend on checker-erased dynamic
            // key lowering.
            const symLocal = this.lowerExpr(ctx, nameExpr);
            const v = this.lowerExpr(ctx, p.initializer);
            ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "symbol.set", args: [dst, symLocal, v] });
          } else if (ts.isStringLiteral(nameExpr)) {
            const v = this.lowerExpr(ctx, p.initializer);
            ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField(nameExpr.text), src: v });
          } else if (ts.isNumericLiteral(nameExpr)) {
            // numeric computed key -> JS coerces to the string form of the number
            const v = this.lowerExpr(ctx, p.initializer);
            ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField(String(Number(nameExpr.text))), src: v });
          } else {
            // dynamic key: evaluate key then store. ts_set_dyn applies runtime
            // ToPropertyKey (string/number keys and symbols).
            const key = this.lowerExpr(ctx, nameExpr);
            const v = this.lowerExpr(ctx, p.initializer);
            ctx.body.push({ kind: "StoreFieldDynamic", obj: dst, key, src: v });
          }
        } else if (ts.isShorthandPropertyAssignment(p)) {
          // {a} === {a: a}: symbolOf resolves the shorthand name to its value
          // binding (not the property symbol), so lowerIdentifier reads `a`.
          const v = this.lowerIdentifier(ctx, p.name);
          ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField(p.name.text), src: v });
        } else if (ts.isSpreadAssignment(p)) {
          // {...src}: copy src's own enumerable props (later props override).
          const src = this.lowerExpr(ctx, p.expression);
          ctx.body.push({ kind: "ObjectCopyProps", dst, src });
        } else if (ts.isMethodDeclaration(p) && p.body && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          // { greet() {...} } — a method-shorthand. In JS this is just an
          // enumerable data property holding a function (NOT a separate method
          // namespace): `o.greet`, Object.keys, JSON all see it; a same-named data
          // property overwrites it (last wins). So we lift the body as a closure
          // with this=object and store it under the ordinary field-key, exactly
          // like `{ greet: fn }`. `o.greet()` finds it via the own (field-key)
          // lookup that the method-call path now tries first.
          const fnLocal = this.lowerClosure(ctx, p as unknown as FnLike, p.name.text, /*thisParam*/ true);
          ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField(p.name.text), src: fnLocal });
        } else if ((ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.body &&
                   (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          // { get x() {...} } / { set x(v) {...} } — an accessor property. Emit one
          // defineAccessor per name (pairing a get+set), at the first occurrence.
          // Object-literal accessors are ENUMERABLE and configurable (V8: Object.keys
          // lists them), unlike class-syntax accessors. Lift with this=object.
          const nm = p.name.text;
          if (emittedAcc.has(nm)) continue;
          emittedAcc.add(nm);
          const pair = accPairs.get(nm)!;
          const undefLocal = () => { const u = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } }); return u; };
          const getter = pair.get ? this.lowerClosure(ctx, pair.get as unknown as FnLike, "getter", true) : undefLocal();
          const setter = pair.set ? this.lowerClosure(ctx, pair.set as unknown as FnLike, "setter", true) : undefLocal();
          const keyLocal = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Const", dst: keyLocal, value: { kind: "Str", value: nm } });
          const gThis = pair.get ? 1 : 0;
          const sThis = pair.set ? 1 : 0;
          // enumerable=1, configurable=1 (object-literal accessor defaults).
          ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
            builtin: `object.defineAccessor:${gThis}:${sThis}:1:1`, args: [dst, keyLocal, getter, setter] });
        } else if (ts.isMethodDeclaration(p) && p.body && ts.isComputedPropertyName(p.name) &&
                   this.isSymbolKeyExpr(p.name.expression)) {
          // { [Symbol.iterator]() {...} } — a computed-name method keyed by a
          // (well-known or user) symbol. Lift with this=object and store under the
          // symbol key (symbol.set with the symbol value). A well-known symbol's
          // key is TS_KEY_WKSYM(id), matching the class [Symbol.iterator]() form,
          // so for-of resolves it identically.
          const fnLocal = this.lowerClosure(ctx, p as unknown as FnLike, "symmethod", /*thisParam*/ true);
          const symLocal = this.lowerExpr(ctx, p.name.expression);
          ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
            builtin: "symbol.set", args: [dst, symLocal, fnLocal] });
        } else {
          this.unsupported(p, `object literal member ${ts.SyntaxKind[p.kind]}`);
        }
      }
      return dst;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const site = this.site++;
      const dst = this.newLocal(ctx, "reference", hint);
      this.labels[site] = `${hint ?? "arr"}@${ctx.name}`;
      this.recordSite(site, "array", this.inLoop(node) ? "many" : "once", false, node);
      let contiguous = true;
      for (const el of node.elements) if (ts.isSpreadElement(el)) contiguous = false;
      const holes = node.elements.some((el) => ts.isOmittedExpression(el));
      if (contiguous && !holes && node.elements.length > 0 && process.env.TSAOT_ARRAY_LIT !== "0") {
        // The elements first (left to right, as before), then the array and its stores by index:
        // the emitter fuses `AllocArray; (Const i; StoreIndex)*` into one allocation filled from
        // the elements (emit_c.rs array_lits_for). Where the array is allocated is unobservable;
        // the elements' evaluation order is what the program sees. TSAOT_ARRAY_LIT=0 keeps the
        // old order (and the emitter its separate stores).
        const vals = node.elements.map((el) => this.lowerExpr(ctx, el as ts.Expression));
        ctx.body.push({ kind: "AllocArray", dst, elemType: 0, site });
        vals.forEach((v, i) => {
          const idx = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst: idx, value: { kind: "Num", value: i } });
          ctx.body.push({ kind: "StoreIndex", arr: dst, index: idx, src: v });
        });
        return dst;
      }
      ctx.body.push({ kind: "AllocArray", dst, elemType: 0, site });
      if (contiguous) {
        // fast path: no spread, assign by static index
        node.elements.forEach((el, i) => {
          if (ts.isOmittedExpression(el)) {
            ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
              builtin: "array.pushHole", args: [dst] });
            return;
          }
          const v = this.lowerExpr(ctx, el);
          const idx = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst: idx, value: { kind: "Num", value: i } });
          ctx.body.push({ kind: "StoreIndex", arr: dst, index: idx, src: v });
        });
      } else {
        // spread present: append (push) each element / spread source in order
        for (const el of node.elements) {
          if (ts.isSpreadElement(el)) {
            const srcArr = this.lowerExpr(ctx, el.expression);
            ctx.body.push({ kind: "ArrayPushAll", arr: dst, src: srcArr });
          } else if (ts.isOmittedExpression(el)) {
            ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
              builtin: "array.pushHole", args: [dst] });
          } else {
            const v = this.lowerExpr(ctx, el);
            ctx.body.push({ kind: "ArrayPush", arr: dst, src: v });
          }
        }
      }
      return dst;
    }
    if (ts.isIdentifier(node)) return this.lowerIdentifier(ctx, node);
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      if (ctx.thisLocal !== undefined) return ctx.thisLocal;
      return this.lowerUnboundThis(ctx);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const enumValue = this.constEnumMemberValue(node);
      if (enumValue !== undefined) return this.lowerEnumConstant(ctx, enumValue, hint);
      // `re.lastIndex` on a receiver typed RegExp: the slot read (`regexp.getLastIndex`; the
      // runtime takes the generic path when the value is not a RegExp with a plain lastIndex)
      if (node.name.text === "lastIndex" && this.isRegExpExpr(node.expression)) {
        const recv = this.lowerExpr(ctx, node.expression);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.getLastIndex", args: [recv] });
        return dst;
      }
      if (node.name.text === "length" && ts.isIdentifier(node.expression) &&
          node.expression.text === "arguments" &&
          !this.symbolOf(node.expression)?.declarations?.length) {
        const dst = this.newLocal(ctx, "primitive");
        if (ctx.argumentsOffset === undefined || ctx.isAsync || ctx.isGenerator)
          this.unsupported(node, "arguments.length in an arrow or coroutine");
        ctx.body.push({ kind: "CallBuiltinStatic", dst,
          builtin: `arguments.length:${ctx.argumentsOffset ?? 0}`, args: [] });
        return dst;
      }
      if (this.isGlobalThisPropertyAccess(node, "fetch")) {
        return this.loadGlobalObjectProperty(ctx, "fetch");
      }
      if (this.isGlobalThisPropertyAccess(node, "RegExp")) {
        this.unsupported(node, "globalThis.RegExp as a value (not implemented)");
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
        return dst;
      }
      // `super.X` (READ) inside a STATIC body: resolve X starting at the parent
      // class. A getter/method runs with this=the current receiver (subclass view);
      // a data field reads the parent's container chain (super doesn't see subclass
      // shadows). (`super.X()` CALLs are handled in the call path.)
      if (node.expression.kind === ts.SyntaxKind.SuperKeyword && ctx.staticClass !== undefined && ctx.thisLocal !== undefined) {
        const parent = this.parentIdOf(ctx.staticClass);
        if (parent !== undefined) {
          const gfn = this.staticGetterFnOf(parent, node.name.text);
          if (gfn !== undefined) {
            const dst = this.newLocal(ctx, this.refKindOf(node));
            ctx.body.push({ kind: "Call", dst, callee: { kind: "Direct", func: gfn }, args: [ctx.thisLocal] });
            return dst;
          }
          const sm = this.resolveStaticMethod(parent, node.name.text);
          if (sm !== undefined) {
            const dst = this.newLocal(ctx, "reference", node.name.text);
            const site = this.site++;
            this.labels[site] = `super-static-fnref ${node.name.text}@${ctx.name}`;
            this.recordSite(site, "closure", "once", true, node);
            ctx.body.push({ kind: "AllocClosure", dst, func: sm.fnId, captures: [], site });
            return dst;
          }
          const fcid = this.staticFieldClassOf(parent, node.name.text);
          if (fcid !== undefined) {
            const cont = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "LoadGlobal", dst: cont, gref: this.classStaticGlobal.get(fcid)! });
            const dst = this.newLocal(ctx, (node.name.text === "name" || node.name.text === "length") ? "reference" : this.refKindOf(node));
            ctx.body.push({ kind: "LoadField", dst, obj: cont, field: this.internField(node.name.text) });
            return dst;
          }
          if (node.name.text === "name") {
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "Const", dst, value: { kind: "Str", value: this.classInfos[parent]?.name ?? "" } });
            return dst;
          }
          if (node.name.text === "length") {
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "Const", dst, value: { kind: "Num", value: this.jsFunctionArity(this.ctorNodeOfClassId(parent)?.parameters) } });
            return dst;
          }
        }
      }
      // INSTANCE `super.x` READ: [[Get]] on the parent PROTOTYPE with this=receiver.
      // A parent getter is invoked (this=instance), a parent method yields its function
      // value, and ANYTHING ELSE — an instance DATA field (which lives on the instance,
      // not the prototype), a setter-only accessor, or an absent member — reads as
      // undefined (matching JS). The getter is Direct-called via `recv` (not args[0]),
      // so SROA's inline_callee scalar-replaces its `this.field` read on a non-escaping
      // instance (§86). `super.m()` calls are handled earlier in the call path.
      if (node.expression.kind === ts.SyntaxKind.SuperKeyword && ctx.currentClass !== undefined && ctx.thisLocal !== undefined) {
        const parent = this.parentIdOf(ctx.currentClass);
        if (parent !== undefined) {
          const gfn = this.resolveMemberFunc(parent, node.name.text, "getter");
          if (gfn !== undefined) {
            const dst = this.newLocal(ctx, this.refKindOf(node));
            ctx.body.push({ kind: "Call", dst, recv: ctx.thisLocal, callee: { kind: "Direct", func: gfn }, args: [] });
            return dst;
          }
          const mfn = this.resolveMemberFunc(parent, node.name.text, "method");
          if (mfn !== undefined) {
            const dst = this.newLocal(ctx, "reference", node.name.text);
            const site = this.site++;
            this.labels[site] = `super-instance-fnref ${node.name.text}@${ctx.name}`;
            this.recordSite(site, "closure", "once", true, node);
            ctx.body.push({ kind: "AllocClosure", dst, func: mfn, captures: [], site });
            return dst;
          }
        }
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
        return dst;
      }
      if (node.name.text === "prototype") {
        const classId = this.classIdOfIdentifier(node.expression);
        if (classId !== undefined) {
          const klass = this.lowerExpr(ctx, node.expression);
          return this.loadClassValuePrototype(ctx, klass);
        }
      }
      // Step F: ClassName.staticField -> load the class's static container from
      // its GLOBALS[] slot, then read the field. Detect when the receiver is a
      // class identifier whose class has a static container.
      if (ts.isIdentifier(node.expression)) {
        const csym = this.symbolOf(node.expression);
        const cid = csym ? this.classSymToId.get(csym) : undefined;
        // A static METHOD referenced as a VALUE (`const f = C.make`, callback,
        // `C.m.bind(...)`): box the lifted static function as a ts_func. The body
        // takes `this` as arg0 (takes_this=1), so bind/call/apply honor the thisArg
        // and a detached `f()` gets this=undefined (JS). Must come BEFORE the field
        // read below. (`C.m()` CALLs are resolved in the call path.)
        if (cid !== undefined) {
          const sm = this.resolveStaticMethod(cid, node.name.text);
          if (sm !== undefined) {
            const dst = this.newLocal(ctx, "reference", node.name.text);
            const site = this.site++;
            this.labels[site] = `static-fnref ${node.name.text}@${ctx.name}`;
            this.recordSite(site, "closure", "once", true, node);
            ctx.body.push({ kind: "AllocClosure", dst, func: sm.fnId, captures: [], site });
            return dst;
          }
        }
        // Static FIELD read: `C.x` -> load C's own static container (the nearest class with one) and
        // read the property via ts_get: the containers are proto-linked along the class chain, so an
        // inherited static resolves, and a subclass's own static written through `this` in an inherited
        // static method or setter (`++this.count` run as `Sub.bump()`) shadows the parent's, as in JS.
        // A static getter: a Direct call with the class value as `this` (the generic read below would
        // run it with the container).
        const gfn = cid !== undefined ? this.staticAccessorBeforeField(cid, node.name.text, "get") : undefined;
        if (cid !== undefined && gfn !== undefined && this.staticContainerClassOf(cid) !== undefined) {
          const recv = this.staticReceiver(ctx, node.expression, cid, this.staticContainerClassOf(cid)!);
          const dst = this.newLocal(ctx, this.refKindOf(node));
          ctx.body.push({ kind: "Call", dst, callee: { kind: "Direct", func: gfn }, args: [recv] });
          return dst;
        }
        const scid = this.staticContainerClassOf(cid);
        if (cid !== undefined && scid !== undefined) {
          const gid = this.classStaticGlobal.get(scid)!;
          const cont = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadGlobal", dst: cont, gref: gid });
          const dst = this.newLocal(ctx, (node.name.text === "name" || node.name.text === "length") ? "reference" : this.refKindOf(node));
          ctx.body.push({ kind: "LoadField", dst, obj: cont, field: this.internField(node.name.text) });
          return dst;
        }
      }
      // Math.PI / Math.E ... and Number.* constants -> numeric Const.
      // Symbol-gated: a user `const Math = {...}` shadows the global, so only
      // treat as a namespace constant when the identifier resolves to the
      // stdlib global.
      if (ts.isIdentifier(node.expression) && this.isAmbientGlobalSymbol(this.symbolOf(node.expression))) {
        if (node.expression.text === "Number") {
          const special: Record<string, string> = { POSITIVE_INFINITY: "PosInf", NEGATIVE_INFINITY: "NegInf", NaN: "NaN" };
          const kind = special[node.name.text];
          if (kind) {
            const dst = this.newLocal(ctx, "primitive");
            ctx.body.push({ kind: "Const", dst, value: { kind } });
            return dst;
          }
        }
        const constVal = this.namespaceConstant(node.expression.text, node.name.text);
        if (constVal !== undefined) {
          const dst = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst, value: { kind: "Num", value: this.numWire(constVal) } });
          return dst;
        }
      }
      // map.size / set.size -> runtime size (returns a number)
      if (node.name.text === "size") {
        const k = this.builtinReceiverKind(node.expression) ?? this.derivedCollectionKind(node.expression);
        if (k === "map" || k === "set") {
          const recv = this.lowerExpr(ctx, node.expression);
          const dst = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "CallBuiltin", dst, builtin: `${k}.size`, recv, args: [] });
          return dst;
        }
      }
      // .length : string length for strings, element count for arrays. Route by
      // the receiver's static kind; fall back to a generic runtime length op when
      // the type is unknown (e.g. `await resp.text()` typed loosely).
      if (node.name.text === "length") {
        if (ts.isCallExpression(node.expression) &&
            ts.isPropertyAccessExpression(node.expression.expression) &&
            node.expression.expression.name.text === "stringify" &&
            ts.isIdentifier(node.expression.expression.expression) &&
            node.expression.expression.expression.text === "JSON" &&
            this.isAmbientGlobalSymbol(this.symbolOf(node.expression.expression.expression))) {
          const call = node.expression;
          if (call.arguments.length === 1 ||
              (call.arguments.length >= 2 &&
               (call.arguments[1].kind === ts.SyntaxKind.NullKeyword ||
                (ts.isIdentifier(call.arguments[1]) && call.arguments[1].text === "undefined")))) {
            let indent: string | undefined = undefined;
            if (call.arguments.length >= 3) {
              const sp = call.arguments[2];
              if (ts.isNumericLiteral(sp)) indent = " ".repeat(Math.max(0, Math.min(10, Number(sp.text) | 0)));
              else if (ts.isStringLiteral(sp) || ts.isNoSubstitutionTemplateLiteral(sp)) indent = sp.text.slice(0, 10);
            }
            if (this.canLowerJsonStringifyLenStatic(call.arguments[0])) {
              const staticLen = this.lowerJsonStringifyLenStatic(ctx, call.arguments[0], node, indent);
              if (staticLen !== undefined) return staticLen;
            }
          }
        }
        // Only a string or an array answers `.length` with its own number;
        // any other receiver (an object with a `length` property, ArrayLike,
        // a function, any, unknown, null) reads the property below.
        const rk = this.builtinReceiverKind(node.expression);
        if (rk === "array" || rk === "string" || this.lengthIsBuiltinNumber(node)) {
          const base = this.lowerExpr(ctx, node.expression);
          const dst = this.newLocal(ctx, "primitive");
          if (rk === "array") {
            ctx.body.push({ kind: "ArrayLen", dst, arr: base });
          } else if (rk === "string") {
            ctx.body.push({ kind: "StringLen", dst, src: base });
          } else {
            ctx.body.push({ kind: "GenericLen", dst, src: base });
          }
          return dst;
        }
        if (process.env.TSAOT_LENGTH_LOG === "1") {
          const sf = node.getSourceFile();
          const lc = sf.getLineAndCharacterOfPosition(node.getStart());
          let ty = "?";
          try { ty = this.checker.typeToString(this.checker.getTypeAtLocation(node.expression)); } catch { /* keep ? */ }
          console.error(`[length] property read ${sf.fileName}:${lc.line + 1}:${lc.character + 1} ${ty}`);
        }
      }
      // sym.description -> the symbol's description string (or undefined).
      if (node.name.text === "description") {
        try {
          const t = this.checker.getTypeAtLocation(node.expression);
          if (t.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) {
            const recv = this.lowerExpr(ctx, node.expression);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "symbol.description", args: [recv] });
            return dst;
          }
        } catch { /* fall through to normal field load */ }
      }
      // Symbol.iterator / Symbol.asyncIterator / ... used as a VALUE -> the
      // well-known symbol singleton (symbol_design.md stage 2). Its key maps to
      // TS_KEY_WKSYM(id), matching class/object-literal [Symbol.X]() methods.
      if (ts.isIdentifier(node.expression) && this.isBuiltinNamespaceRef(node.expression, "Symbol")) {
        const wk = this.wellKnownSymbolId(node);
        if (wk !== undefined) {
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: `symbol.wksym:${wk}`, args: [] });
          return dst;
        }
      }
      // getter: obj.x where x is an accessor -> a method call (not a field load)
      const gClass = this.classOfExpr(node.expression);
      if (gClass !== undefined && this.hasGetter(gClass, node.name.text)) {
        const recv = this.lowerExpr(ctx, node.expression);
        const dst = this.newLocal(ctx, this.refKindOf(node));
        ctx.body.push({
          kind: "Call", dst, recv, args: [],
          callee: { kind: "Method", recvClass: gClass, method: this.internName(`get ${node.name.text}`),
                    recvStable: this.classExtractor.recvStableAt(node.expression) },
        });
        return dst;
      }
      // (C) A class instance METHOD referenced as a VALUE (`c.m` not called). The
      // method is boxed on CLASS_PROTO under a method key (own + inherited via the
      // prototype chain), so ts_get resolves it. Unbound (like JS): `.bind/.call/
      // .apply` work; a bare detached call has this=undefined. (`c.m()` CALLs go
      // through the call path and never reach here.) A same-named field (e.g. an
      // arrow-function field) shadows the prototype method -> keep the field read.
      if (gClass !== undefined && this.classHasMethod(gClass, node.name.text) && !this.classHasField(gClass, node.name.text)) {
        const recv = this.lowerExpr(ctx, node.expression);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadMethodValue", dst, recv, method: this.internName(node.name.text) });
        return dst;
      }
      // First-class builtin VALUES: a builtin method/function referenced as a
      // VALUE (not called). Method/static CALLs go through the call path and
      // never reach here, so reaching this point with a builtin member is a
      // value reference. (A) namespace static function (Math.sqrt/Object.keys/
      // console.log/...); (B) prototype method (arr.push/"s".toUpperCase/...).
      // `Object.prototype.<modeled method>` as a first-class VALUE
      // (or the receiver of `....hasOwnProperty.call(o,k)`): box the matching
      // `objproto.*` adapter (takes_this=1, so .call/.apply/.bind supply `this`).
      // Must run before lowering `node.expression` (`Object.prototype`), which would
      // otherwise loud-reject as an unsupported first-class value.
      const opm = this.objectProtoMethodName(node);
      if (opm !== undefined) {
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadBuiltinFn", dst, builtin: `objproto.${opm}` });
        return dst;
      }
      // `Array/String/Map/Set/Number.prototype.<m>` as a first-class VALUE (or the
      // receiver of `....slice.call(arr, i)`): load the runtime prototype object
      // (`protoobj.<kind>`) and read the boxed, takes_this=1 method off it via a
      // method key — identical to the instance value form (B) below, just with the
      // prototype itself as the receiver. Must run before lowering `node.expression`
      // (`Array.prototype`), which would otherwise loud-reject.
      const bpm = this.builtinProtoMethod(node);
      if (bpm !== undefined) {
        const recv = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadBuiltinFn", dst: recv, builtin: `protoobj.${bpm.kind}` });
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadMethodValue", dst, recv, method: this.internName(bpm.method) });
        return dst;
      }
      // A BARE `Array/String/Map/Set/Number.prototype` as a first-class VALUE (no
      // trailing method): load the runtime prototype object directly. Same
      // `protoobj.<kind>` load as the method-value form above, but WITHOUT the
      // LoadMethodValue — the value IS the prototype object. (Array.prototype is an
      // Array exotic in the runtime, so Array.isArray(Array.prototype) is true,
      // matching V8.) Must run after the method-value check (so `X.prototype.method`
      // wins) and before the namespace first-class-value reject below.
      const bpk = this.bareBuiltinProtoKind(node);
      if (bpk !== undefined) {
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadBuiltinFn", dst, builtin: `protoobj.${bpk}` });
        return dst;
      }
      // (A) namespace static function value. (Constants like Math.PI / wksyms are
      // resolved earlier, so a builtin-namespace member reaching here is a
      // function reference.) Load it from the runtime global namespace object
      // instead of boxing a fresh adapter, so identity matches
      // `globalThis.<ns>.<member>`.
      if (ts.isIdentifier(node.expression) && this.isKnownBuiltinNamespaceRef(node.expression)) {
        const nsName = node.expression.text;
        const bn = this.builtinFnValueName(nsName, node.name.text);
        if (bn !== undefined) {
          const nsObj = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadBuiltinFn", dst: nsObj, builtin: `globalobj.${nsName}` });
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadField", dst, obj: nsObj, field: this.internField(node.name.text) });
          return dst;
        }
        // `Symbol.<name>` that is not a well-known symbol the runtime defines (`Symbol.observable`): undefined,
        // as in V8 without a polyfill (rxjs tests for it and falls back to a string key); a write stays rejected.
        if (nsName === "Symbol") {
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
          return dst;
        }
        // A builtin-namespace function we don't represent as a first-class value
        // (e.g. Object.assign, Promise.resolve). Loud-reject rather than silently
        // loading undefined. (CALLs go through the call path and never reach here.)
        this.unsupported(node, `'${nsName}.${node.name.text}' as a first-class value (unsupported builtin function value)`);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
        return dst;
      }
      // (B) prototype method value: recv is evaluated (side effects); the boxed,
      // unbound method is read from its prototype via a method key at runtime.
      // Includes promise.then/catch/finally as a value: ts_get on a promise now
      // resolves them via the shared Promise.prototype (runtime), so `typeof
      // p.then` is "function" and `p.then.call(p, cb)` works.
      const vrk = this.builtinReceiverKind(node.expression);
      if (vrk !== undefined && this.builtinMethodName2(vrk, node.name.text) !== undefined) {
        const recv = this.lowerExpr(ctx, node.expression);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadMethodValue", dst, recv, method: this.internName(node.name.text) });
        return dst;
      }
      if ((node.name.text === "test" || node.name.text === "exec") && this.isRegExpExpr(node.expression)) {
        const recv = this.lowerExpr(ctx, node.expression);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadMethodValue", dst, recv, method: this.internName(node.name.text) });
        return dst;
      }
      // (D) An Object.prototype method read as a
      // VALUE off ANY object instance (`o.toString`, distinct from the namespace form
      // `Object.prototype.toString` handled above and a class method handled at (C)).
      // These live on Object.prototype under a METHOD key, which a bare field-read
      // misses — emit a runtime read that returns an OWN data property of any type if
      // present (JS shadow, e.g. `{toString: 42}`), else the inherited prototype
      // method. Primitive receivers are excluded (their toString/valueOf are taken by
      // the vrk path above for string/number; a bare number value is rejected below).
      const objm = node.name.text;
      if ((objm === "toString" || objm === "toLocaleString" || objm === "valueOf" ||
           objm === "hasOwnProperty" || objm === "isPrototypeOf" ||
           objm === "propertyIsEnumerable") &&
          this.refKindOf(node.expression) !== "primitive") {
        const recv = this.lowerExpr(ctx, node.expression);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltinStatic", dst,
          builtin: `object.methodValue:${this.internField(objm)}:${this.internName(objm)}`, args: [recv] });
        return dst;
      }
      // A property/method on a raw number value with no representable value form
      // (e.g. `(5).toLocaleString`): numbers carry no data properties. Reject
      // loudly rather than silently loading undefined.
      if (this.refKindOf(node.expression) === "primitive") {
        // A receiver narrowed to exactly null/undefined (strictNullChecks) is not
        // a number. Such an access only reaches here as the guarded (statically
        // dead) branch of an optional chain whose receiver is `null` — the value
        // is `undefined`. Emit that instead of mis-rejecting it as numeric.
        if (this.typeIsNullishOnly(node.expression)) {
          const u = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
          return u;
        }
        this.unsupported(node, `'.${node.name.text}' as a value on a number (unsupported)`);
      }
      const base = this.lowerExpr(ctx, node.expression);
      const dst = this.newLocal(ctx, this.refKindOf(node));
      const load = this.withClassHint(this.withSlots({ kind: "LoadField", dst, obj: base, field: this.internField(node.name.text) }, this.staticSlotHint(node.expression, node.name.text)), node.expression);
      ctx.body.push(node.name.text === "length" ? this.withViewElem(load, node.expression) : load);
      return dst;
    }
    if (ts.isElementAccessExpression(node)) {
      const enumValue = this.constEnumMemberValue(node);
      if (enumValue !== undefined) return this.lowerEnumConstant(ctx, enumValue, hint);
      if (this.isGlobalThisPropertyAccess(node, "fetch")) {
        return this.loadGlobalObjectProperty(ctx, "fetch");
      }
      if (this.isGlobalThisPropertyAccess(node, "RegExp")) {
        this.unsupported(node, "globalThis.RegExp as a value (not implemented)");
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
        return dst;
      }
      const base = this.lowerExpr(ctx, node.expression);
      // obj[symbolKey] — symbol-keyed property read (user OR well-known symbol).
      if (this.isSymbolKeyExpr(node.argumentExpression)) {
        const symLocal = this.lowerExpr(ctx, node.argumentExpression);
        const dst = this.newLocal(ctx, this.refKindOf(node));
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "symbol.get", args: [base, symLocal] });
        return dst;
      }
      // String-keyed access on an object is a property load (via field table),
      // not array indexing. Detect by the index expression's static type.
      const ak = this.indexAccessKind(node);
      if (ak === "string") {
        const key = this.lowerExpr(ctx, node.argumentExpression);
        const dst = this.newLocal(ctx, this.refKindOf(node));
        this.markNullableNumeric(ctx, dst, node);
        ctx.body.push({ kind: "LoadFieldDynamic", dst, obj: base, key });
        return dst;
      }
      const idx = this.lowerExpr(ctx, node.argumentExpression);
      const dst = this.newLocal(ctx, this.refKindOf(node));
      this.markNullableNumeric(ctx, dst, node);
      ctx.body.push(this.withViewElem({ kind: "LoadIndex", dst, arr: base, index: idx }, node.expression));
      return dst;
    }
    if (ts.isCallExpression(node)) {
      // console.log(x) -> Print
      // The callee less its parentheses and type casts: `(obj.method as any)(x)` and `obj.cb!(x)`
      // are method calls with `obj` as the receiver (a parenthesized expression is the same
      // Reference), not calls of a detached function value.
      const fnx = this.unwrapExpr(node.expression);
      if (node.arguments.some(a => ts.isSpreadElement(a)) && ts.isPropertyAccessExpression(fnx)) {
        const receiverKind = this.builtinReceiverKind(fnx.expression);
        if (receiverKind && this.builtinMethodName2(receiverKind, fnx.name.text)) {
          let recv = this.lowerExpr(ctx, fnx.expression);
          if (this.isMutableStorageLocal(ctx, recv)) {
            const snapshot = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "Copy", dst: snapshot, src: recv });
            recv = snapshot;
          }
          const callee = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadMethodValue", dst: callee, recv, method: this.internName(fnx.name.text) });
          return this.lowerDynamicValueCall(ctx, callee, recv, node.arguments, this.refKindOf(node));
        }
        if (ts.isIdentifier(fnx.expression) && this.isAmbientGlobalSymbol(this.symbolOf(fnx.expression)) &&
            this.builtinFnValueName(fnx.expression.text, fnx.name.text) &&
            !this.globalMemberMaybeMutated(fnx.expression.text, fnx.name.text)) {
          return this.lowerDynamicValueCall(ctx, this.lowerExpr(ctx, fnx), undefined, node.arguments, this.refKindOf(node));
        }
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "escape" &&
          ts.isIdentifier(fnx.expression) && fnx.expression.text === "RegExp" &&
          this.isAmbientGlobalSymbol(this.symbolOf(fnx.expression))) {
        const argLs = this.lowerSequenced(ctx, node.arguments);
        const arg = argLs[0] ?? (() => {
          const u = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
          return u;
        })();
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "regexp.escape", args: [arg] });
        return dst;
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "test" &&
          fnx.expression.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        const fallback = this.lowerRegExpLiteralTestFallback(ctx, node, fnx.expression.getText());
        if (fallback !== undefined) return fallback;
        this.unsupported(node, "RegExp literal has invalid flags");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "test" &&
          this.isRegExpExpr(fnx.expression)) {
        return this.lowerRegExpObjectTestCall(ctx, node, fnx.expression);
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "exec" &&
          fnx.expression.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        const fallback = this.lowerRegExpLiteralExecFallback(ctx, node, fnx.expression.getText());
        if (fallback !== undefined) return fallback;
        this.unsupported(node, "RegExp literal has invalid flags");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "exec" &&
          this.isRegExpExpr(fnx.expression)) {
        return this.lowerRegExpObjectExecCall(ctx, node, fnx.expression);
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "search" &&
          node.arguments.length >= 1 &&
          node.arguments[0].kind === ts.SyntaxKind.RegularExpressionLiteral &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const fallback = this.lowerStringSearchRegExpFallback(ctx, node, fnx.expression, node.arguments[0].getText());
        if (fallback !== undefined) return fallback;
        this.unsupported(node, "RegExp literal has invalid flags");
        return this.newLocal(ctx, "primitive");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "search" &&
          node.arguments.length >= 1 &&
          this.isRegExpExpr(node.arguments[0]) &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        return this.lowerStringSearchRegExpObject(ctx, node, fnx.expression, node.arguments[0]);
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "search" &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const lowered = this.lowerStringSearchStringPattern(ctx, node, fnx.expression);
        if (lowered !== undefined) return lowered;
        this.unsupported(node, "String.prototype.search(string) requires a const string pattern");
        return this.newLocal(ctx, "primitive");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "match" &&
          node.arguments.length >= 1 &&
          node.arguments[0].kind === ts.SyntaxKind.RegularExpressionLiteral &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const lowered = this.lowerStringMatchRegExpLiteral(ctx, node, fnx.expression, node.arguments[0].getText());
        if (lowered !== undefined) return lowered;
        this.unsupported(node, "RegExp literal has invalid flags");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "match" &&
          node.arguments.length >= 1 &&
          this.isRegExpExpr(node.arguments[0]) &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        return this.lowerStringMatchRegExpObject(ctx, node, fnx.expression, node.arguments[0]);
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "match" &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const lowered = this.lowerStringMatchStringPattern(ctx, node, fnx.expression);
        if (lowered !== undefined) return lowered;
        this.unsupported(node, "String.prototype.match(string) requires a const string pattern");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "matchAll" &&
          node.arguments.length >= 1 &&
          node.arguments[0].kind === ts.SyntaxKind.RegularExpressionLiteral &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const lowered = this.lowerStringMatchAllRegExpLiteral(ctx, node, fnx.expression, node.arguments[0].getText());
        if (lowered !== undefined) return lowered;
        this.unsupported(node, "RegExp literal has invalid flags");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "matchAll" &&
          node.arguments.length >= 1 &&
          this.isRegExpExpr(node.arguments[0]) &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const lowered = this.lowerStringMatchAllRegExpObject(ctx, node, fnx.expression, node.arguments[0]);
        if (lowered !== undefined) return lowered;
        this.unsupported(node, "String.prototype.matchAll(RegExp) unsupported");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "matchAll" &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const lowered = this.lowerStringMatchAllStringPattern(ctx, node, fnx.expression);
        if (lowered !== undefined) return lowered;
        this.unsupported(node, "String.prototype.matchAll(string) requires a const string pattern");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          (fnx.name.text === "replace" || fnx.name.text === "replaceAll") &&
          node.arguments.length >= 1 &&
          node.arguments[0].kind === ts.SyntaxKind.RegularExpressionLiteral &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const replaceAll = fnx.name.text === "replaceAll";
        const lowered = this.lowerStringReplaceRegExpLiteral(ctx, node, fnx.expression, node.arguments[0].getText(), replaceAll);
        if (lowered !== undefined) return lowered;
        this.unsupported(node, "RegExp literal has invalid flags");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          (fnx.name.text === "replace" || fnx.name.text === "replaceAll") &&
          node.arguments.length >= 1 &&
          this.isRegExpExpr(node.arguments[0]) &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const replaceAll = fnx.name.text === "replaceAll";
        const lowered = this.lowerStringReplaceRegExpObject(ctx, node, fnx.expression, node.arguments[0], replaceAll);
        if (lowered !== undefined) return lowered;
        this.unsupported(node, replaceAll
          ? "String.prototype.replaceAll(RegExp) requires a global RegExp"
          : "String.prototype.replace(RegExp) unsupported");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "split" &&
          node.arguments.length >= 1 &&
          node.arguments[0].kind === ts.SyntaxKind.RegularExpressionLiteral &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        const lowered = this.lowerStringSplitRegExpLiteral(ctx, node, fnx.expression, node.arguments[0].getText());
        if (lowered !== undefined) return lowered;
        this.unsupported(node, "RegExp literal has invalid flags");
        return this.newLocal(ctx, "reference");
      }
      if (ts.isPropertyAccessExpression(fnx) &&
          fnx.name.text === "split" &&
          node.arguments.length >= 1 &&
          this.isRegExpExpr(node.arguments[0]) &&
          this.builtinReceiverKind(fnx.expression) === "string") {
        return this.lowerStringSplitRegExpObject(ctx, node, fnx.expression, node.arguments[0]);
      }
      if ((ts.isPropertyAccessExpression(fnx) || ts.isElementAccessExpression(fnx)) &&
          this.isGlobalThisPropertyAccess(fnx, "fetch")) {
        if (this.globalNameMaybeMutated("fetch")) {
          const calleeLocal = this.lowerExpr(ctx, fnx);
          return this.lowerDynamicValueCall(ctx, calleeLocal, undefined, node.arguments, this.refKindOf(node));
        }
        const argLs = this.lowerSequenced(ctx, node.arguments);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "global.fetch", args: argLs });
        return dst;
      }
      if ((ts.isPropertyAccessExpression(fnx) || ts.isElementAccessExpression(fnx)) &&
          this.isGlobalThisPropertyAccess(fnx, "RegExp")) {
        this.unsupported(node, "globalThis.RegExp(...) (not implemented)");
        return this.newLocal(ctx, "reference");
      }
      // C0 (property_model_redesign §3.6): real Symbols are not implemented. A call
      // to Symbol(...) / Symbol.for(...) / Symbol.keyFor(...) would otherwise lower
      // to a call on an undefined `Symbol` and trap at runtime ("value is not a
      // function") — i.e. silently-deferred failure. Reject at compile time instead.
      // Symbol(desc) — create a fresh unique symbol (symbol_design.md stage 1).
      // Symbol.for / Symbol.keyFor (the global registry) are stage 3, still
      // rejected below until implemented.
      if (ts.isIdentifier(fnx) && fnx.text === "Symbol" && this.isAmbientGlobalSymbol(this.symbolOf(fnx)) &&
          !this.globalNameMaybeMutated("Symbol")) {
        const descLocal = node.arguments.length > 0
          ? this.lowerExpr(ctx, node.arguments[0])
          : (() => { const u = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } }); return u; })();
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "symbol.new", args: [descLocal] });
        return dst;
      }
      // Object.prototype.toString.call(thisArg) / .apply(thisArg, ...): the spec
      // Object.prototype.toString applied to thisArg (args[0]; undefined if absent).
      // This yields the internal type tag ("[object Array]" etc.), distinct from
      // thisArg.toString(). toString takes no params, so .apply's array is ignored.
      // hasOwnProperty.call(o, k) / Object.prototype.hasOwnProperty.call(o, k):
      // the own-property check itself (the compiler's core.ts binds the method to
      // a module const and calls it 600k times per compile; the generic path
      // looked `call` up on Function.prototype every time).
      if (ts.isPropertyAccessExpression(fnx) && fnx.name.text === "call" && node.arguments.length <= 2 &&
          !node.arguments.some((a) => ts.isSpreadElement(a)) && this.isObjectProtoHasOwnValue(fnx.expression)) {
        let recv: number;
        if (node.arguments.length > 0) recv = this.lowerExpr(ctx, node.arguments[0]);
        else { recv = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: recv, value: { kind: "Undef" } }); }
        let key: number;
        if (node.arguments.length > 1) key = this.lowerExpr(ctx, node.arguments[1]);
        else { key = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: key, value: { kind: "Undef" } }); }
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "object.hasOwn", args: [recv, key] });
        return dst;
      }
      if (ts.isPropertyAccessExpression(fnx) && (fnx.name.text === "call" || fnx.name.text === "apply") &&
          this.isObjectProtoToString(fnx.expression)) {
        let recv: number;
        if (node.arguments.length > 0) recv = this.lowerExpr(ctx, node.arguments[0]);
        else { recv = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: recv, value: { kind: "Undef" } }); }
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "object.protoToStringCall", args: [recv] });
        return dst;
      }
      if (ts.isPropertyAccessExpression(fnx) && ts.isIdentifier(fnx.expression) &&
          this.isBuiltinNamespaceRef(fnx.expression, "Symbol")) {
        if (this.globalMemberMaybeMutated("Symbol", fnx.name.text)) {
          return this.lowerGlobalMemberDynamicCall(ctx, "Symbol", fnx.name.text, node.arguments, this.refKindOf(node));
        }
        if (fnx.name.text === "for" && node.arguments.length >= 1) {
          const keyLocal = this.lowerExpr(ctx, node.arguments[0]);
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "symbol.for", args: [keyLocal] });
          return dst;
        }
        if (fnx.name.text === "keyFor" && node.arguments.length >= 1) {
          const symLocal = this.lowerExpr(ctx, node.arguments[0]);
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "symbol.keyFor", args: [symLocal] });
          return dst;
        }
        this.unsupported(node, `Symbol.${fnx.name.text}(...) (not implemented)`);
        return this.newLocal(ctx, "reference");
      }
      // console.dir(x): structural inspection of one value.
      if (ts.isPropertyAccessExpression(fnx) && ts.isIdentifier(fnx.expression) &&
          this.isBuiltinNamespaceRef(fnx.expression, "console") && fnx.name.text === "dir") {
        if (this.globalMemberMaybeMutated("console", "dir")) {
          return this.lowerGlobalMemberDynamicCall(ctx, "console", "dir", node.arguments, this.refKindOf(node));
        }
        const a = node.arguments.length ? this.lowerExpr(ctx, node.arguments[0]) : this.newLocal(ctx, "primitive");
        const dst = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "console.dir", args: [a] });
        return dst;
      }
      // console.log/info/debug/warn/error(...args). One-arg log keeps the fast
      // single-value Print path; multiple args (and the other methods) go through
      // a CallBuiltinStatic that prints space-separated. warn/error -> stderr.
      if (ts.isPropertyAccessExpression(fnx) && ts.isIdentifier(fnx.expression) &&
          this.isBuiltinNamespaceRef(fnx.expression, "console") &&
          (fnx.name.text === "log" || fnx.name.text === "info" || fnx.name.text === "debug" ||
           fnx.name.text === "warn" || fnx.name.text === "error")) {
        const m = fnx.name.text;
        if (this.globalMemberMaybeMutated("console", m)) {
          return this.lowerGlobalMemberDynamicCall(ctx, "console", m, node.arguments, this.refKindOf(node));
        }
        const toStdout = (m === "log" || m === "info" || m === "debug");
        const argLs = this.lowerSequenced(ctx, node.arguments);
        if (toStdout && argLs.length === 1) {
          ctx.body.push({ kind: "Print", src: argLs[0] });
          return argLs[0];
        }
        const dst = this.newLocal(ctx, "primitive");
        ctx.body.push({
          kind: "CallBuiltinStatic", dst,
          builtin: toStdout ? "console.log" : "console.error",
          args: argLs,
        });
        return dst;
      }
      // arr.push(x) -> ArrayPush  (ONLY when the receiver is statically an array;
      // a user class with its own .push(x) method must dispatch via the class
      // method, not bash the instance with ArrayPush — e.g. class Stack { items;
      // push(x){ this.items.push(x); } }). This fast path returns the array, not
      // the new length, so it's only valid when the result is DISCARDED (a bare
      // expression statement). When the length is used, fall through to the
      // array.push builtin which returns the correct new length.
      if (ts.isPropertyAccessExpression(fnx) && fnx.name.text === "push" && node.arguments.length === 1 &&
          this.builtinReceiverKind(fnx.expression) === "array" &&
          ts.isExpressionStatement(node.parent)) {
        const arr = this.lowerExpr(ctx, fnx.expression);
        const v = this.lowerExpr(ctx, node.arguments[0]);
        ctx.body.push({ kind: "ArrayPush", arr, src: v });
        return arr;
      }
      // garnet:json `parse<T>(text)` (docs/typed_json_design.md): the schema of T
      // becomes the second argument of a direct call of the module's parse.
      const typedJson = this.typedJsonParseCall(node);
      if (typedJson !== undefined) return this.lowerTypedJsonParse(ctx, node, typedJson);
      let recv: number | undefined;
      let callee: any = { kind: "Unknown" };
      let droppedCallbackArgs: Set<number> | undefined;
      const fn = this.unwrapExpr(node.expression);
      const nsTarget = ts.isPropertyAccessExpression(fn) ? this.namespaceMemberCallTarget(fn) : undefined;
      if (nsTarget !== undefined) {
        // `N.f(...)` where `N` names a value namespace and `f` one of its
        // function declarations: the member is statically known (checked
        // TypeScript cannot reassign it), so call it directly; the namespace
        // object is not touched (the member does not read `this`). Generic
        // members take the same monomorphization as identifier callees.
        const spec = this.specializeGenericCall(node, nsTarget.sym);
        callee = { kind: "Direct", func: spec !== undefined ? spec : nsTarget.fnId };
      } else if (ts.isIdentifier(fn)) {
        const sym = this.symbolOf(fn);
        // A bare identifier is a global built-in callee only if its symbol
        // resolves to the stdlib (lib.*.d.ts) and the user hasn't shadowed it.
        // `isBuiltinSym` is the symbol-based gate (Step A). The legacy
        // `!funcSymbols.has(sym)` guard only caught user *functions*; this also
        // catches user *variables/params* shadowing the name.
        const isBuiltinSym = this.isAmbientGlobalSymbol(sym);
        if (isBuiltinSym && this.globalObjectValueName(fn.text) !== undefined &&
            this.globalNameMaybeMutated(fn.text)) {
          return this.lowerGlobalIdentifierDynamicCall(ctx, fn.text, node.arguments, this.refKindOf(node));
        }
        if (this.isScriptGlobalVarSymbol(sym, fn.text)) {
          return this.lowerGlobalIdentifierDynamicCall(ctx, fn.text, node.arguments, this.refKindOf(node));
        }
        if (fn.text === "RegExp" && isBuiltinSym) {
          const lowered = this.lowerRegExpConstructor(ctx, node, hint);
          if (lowered !== undefined) return lowered;
          this.unsupported(node, "RegExp(...) requires a const string pattern and const string flags");
          return this.newLocal(ctx, "reference", hint);
        }
        // `fetch(...)`: the prelude's function (lib/node/web/fetch.ts) through the global object
        // (docs/web_fetch_api_design.md); the library reaches the runtime's transport as
        // `__garnet_fetch`, lowered to the builtin, which also links the fetch runtime
        if (fn.text === "fetch" && isBuiltinSym && nodePreludeFile !== undefined) {
          return this.lowerGlobalIdentifierDynamicCall(ctx, "fetch", node.arguments, this.refKindOf(node));
        }
        if ((fn.text === "fetch" && isBuiltinSym) || (fn.text === "__garnet_fetch" && this.isLibNodeSymbol(sym))) {
          const argLs = this.lowerSequenced(ctx, node.arguments);
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "global.fetch", args: argLs });
          return dst;
        }
        // Host I/O primitive (self-hosting): __read_stdin() — ambient-declared
        // (host.d.ts), reads all of stdin as a string via the runtime.
        if (fn.text === "__read_stdin" && isBuiltinSym) {
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "global.readStdin", args: [] });
          return dst;
        }
        if ((fn.text === "parseInt" || fn.text === "parseFloat") && isBuiltinSym) {
          const argLs = this.lowerSequenced(ctx, node.arguments);
          const dst = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: `global.${fn.text}`, args: argLs });
          return dst;
        }
        if ((fn.text === "encodeURIComponent" || fn.text === "decodeURIComponent" || fn.text === "encodeURI" || fn.text === "decodeURI") && isBuiltinSym) {
          const argLs = this.lowerSequenced(ctx, node.arguments);
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: `global.${fn.text}`, args: argLs });
          return dst;
        }
        if ((fn.text === "isNaN" || fn.text === "isFinite") && isBuiltinSym) {
          const argLs = [this.lowerExpr(ctx, node.arguments[0])];
          const dst = this.newLocal(ctx, this.refKindOf(node));
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: `global.${fn.text}`, args: argLs });
          return dst;
        }
        if (fn.text === "Number" && node.arguments.length === 1 && isBuiltinSym) {
          const argLs = [this.lowerExpr(ctx, node.arguments[0])];
          const dst = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "number.coerce", args: argLs });
          return dst;
        }
        if (fn.text === "String" && node.arguments.length === 1 && isBuiltinSym) {
          // String(x): coerce to string (invokes x.toString() for objects).
          const argLs = [this.lowerExpr(ctx, node.arguments[0])];
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "string.coerce", args: argLs });
          return dst;
        }
        if (fn.text === "Boolean" && node.arguments.length === 1 && isBuiltinSym) {
          // Boolean(x): JS truthiness.
          const argLs = [this.lowerExpr(ctx, node.arguments[0])];
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "boolean.coerce", args: argLs });
          return dst;
        }
        // Array(...) called without `new` behaves identically to new Array(...).
        if (fn.text === "Array" && isBuiltinSym) {
          return this.lowerArrayConstruct(ctx, Array.from(node.arguments), node, hint);
        }
        const aliasBuiltin = sym && !node.arguments.some((a) => ts.isSpreadElement(a)) ? this.builtinAliasCallName(sym, node.arguments.length) : undefined;
        if (sym && this.funcSymbols.has(sym)) {
          // Generic function monomorphization: if the callee is generic and the
          // call has concrete type args, route to a specialized clone whose body
          // is lowered with T -> concrete substitution (so params/locals/returns
          // are classified as the concrete scalar and stay unboxed).
          const spec = this.specializeGenericCall(node, sym);
          let func = spec !== undefined ? spec : this.funcSymbols.get(sym)!;
          if (spec === undefined) {
            // Callback specialization: arguments naming module-level functions
            // bind the callee's callback parameters in a clone.
            const cb = this.specializeCallbackCall(node, sym);
            if (cb) { func = cb.func; droppedCallbackArgs = cb.dropped; }
          }
          callee = { kind: "Direct", func };
          if (spec === undefined && this.nestedFuncSymbols.has(sym)) this.ensureNestedLowered(sym);
        } else if (sym && this.callbackSubst?.has(sym)) {
          // A bound callback parameter called inside a specialized clone: the
          // module-level function it names, called directly and specialized in turn.
          const target = this.callbackSubst.get(sym)!;
          let func = this.funcSymbols.get(target)!;
          const cb = this.specializeCallbackCall(node, target);
          if (cb) { func = cb.func; droppedCallbackArgs = cb.dropped; }
          else if (this.nestedFuncSymbols.has(target)) this.ensureNestedLowered(target);
          callee = { kind: "Direct", func };
        } else if (sym && ctx.selfFunctionSymbol === sym) {
          // The lexical name of a named function expression denotes this exact
          // lifted function. The regular Direct-call path below threads captures.
          callee = { kind: "Direct", func: ctx.id };
        } else if (aliasBuiltin !== undefined) {
          // a module-level `const f = NS.member` naming a builtin (vue's `isArray = Array.isArray`): the
          // builtin's static call, as `NS.member(args)` lowers; the binding is read first (a
          // ReferenceError in the TDZ, as V8 throws)
          const fv = this.lowerExpr(ctx, fn);
          this.checkClassBindingInitialized(ctx, fn, fv);
          const argLs = this.lowerSequenced(ctx, node.arguments);
          const numericResult = aliasBuiltin.startsWith("math.") || aliasBuiltin.endsWith("parseInt")
            || aliasBuiltin.endsWith("parseFloat") || aliasBuiltin === "number.coerce" || aliasBuiltin === "date.now";
          const dst = this.newLocal(ctx, numericResult ? "primitive" : "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: aliasBuiltin, args: argLs });
          return dst;
        } else if (sym && this.constFnSymbols.has(sym)) {
          // a module-level `const f = (...) => ...` without `this`, `arguments` or captures: its
          // function, called directly; the binding is read first where the call may precede the
          // declaration (a ReferenceError then, as V8 throws in the TDZ)
          const fv = this.lowerExpr(ctx, fn);
          this.checkClassBindingInitialized(ctx, fn, fv);
          callee = { kind: "Direct", func: this.constFnSymbols.get(sym)! };
        } else {
          // An identifier that is NOT a known top-level function: it may be a
          // local/param holding a first-class function value (a closure). Lower
          // the callee expression to a value and call through it (ts_call, which
          // prepends the closure's captured env). Falls back to Unknown only if
          // we somehow cannot lower it.
          const vloc = this.lowerExpr(ctx, fn);
          if (vloc !== undefined) callee = { kind: "Value", local: vloc };
        }
      } else if (fn.kind === ts.SyntaxKind.SuperKeyword && ctx.currentClass !== undefined) {
        // super(...) constructor call -> Direct to the parent's constructor.
        const parent = this.parentIdOf(ctx.currentClass);
        const cfunc = parent !== undefined ? this.methodFunc.get(`${parent}:ctor`) : undefined;
        if (cfunc !== undefined) {
          // Thread the base ctor's FUNCTION-LOCAL capture cells when it has any
          // (recv-less call with [cells..., this, ...args], matching the prologue).
          // Otherwise keep the recv form and fall through (which also handles
          // spread args). cells===null => cross-scope capture: loud-reject.
          const cells = this.ctorCellArgs(ctx, cfunc);
          if (cells !== null && cells.length > 0) {
            const argLs = this.lowerSequenced(ctx, node.arguments);
            ctx.body.push({ kind: "Call", args: [...cells, ctx.thisLocal!, ...argLs], callee: { kind: "Direct", func: cfunc } });
            const u = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
            return u;
          }
          if (cells === null) {
            this.unsupported(node, "super() of a base class that captures an enclosing function's local not in scope here (cross-scope capture not supported)");
          }
          callee = { kind: "Direct", func: cfunc };
          recv = ctx.thisLocal; // parent ctor initializes the same `this`
        } else {
          // The parent has no explicit constructor. Two cases:
          // (a) the class extends the builtin `Error` (or a subclass): `super(m)`
          //     sets `this.message = m` (the Error constructor's observable
          //     effect). Error isn't a user class, so parentIdOf is undefined.
          // (b) a user parent with only field initializers: run its implicit
          //     construction on `this` (field inits + parent chain). A silent
          //     no-op would skip base-class field initializers.
          const argLs = this.lowerSequenced(ctx, node.arguments);
          if (parent === undefined && this.extendsBuiltinError(ctx.currentClass) && ctx.thisLocal !== undefined) {
            if (argLs.length > 0) {
              // own, non-enumerable `message` (JS Error semantics)
              this.defineDataField(ctx, ctx.thisLocal, "message", argLs[0], 0, 1, 1);
            }
          } else if (parent !== undefined && ctx.thisLocal !== undefined) {
            this.emitImplicitConstruction(ctx, parent, ctx.thisLocal, argLs);
          }
          const u = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
          return u;
        }
      } else if (ts.isPropertyAccessExpression(fn)) {
        // Step F: ClassName.staticMethod(...) -> Direct call to the lifted static
        // function, passing the receiver class's static container as `this` (arg0).
        // The container is proto-linked, so an inherited method invoked on a
        // subclass reads/writes the subclass's static view (`this.X` -> ts_get/ts_set
        // walking the chain): subclass-aware without specialization. (`this.m()`
        // inside a body is a generic dynamic dispatch on the container `this`.)
        if (ts.isIdentifier(fn.expression)) {
          const csym = this.symbolOf(fn.expression);
          const cid = csym ? this.classSymToId.get(csym) : undefined;
          if (cid !== undefined) {
            const sm = this.resolveStaticMethod(cid, fn.name.text);
            const ccid = sm !== undefined ? this.staticContainerClassOf(cid) : undefined;
            if (sm !== undefined && ccid !== undefined) {
              const recv = this.staticReceiver(ctx, fn.expression, cid, ccid);   // the class value as `this`
              const argLs = this.lowerSequenced(ctx, node.arguments);
              const dst = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "Call", dst, callee: { kind: "Direct", func: sm.fnId }, args: [recv, ...argLs] });
              return dst;
            }
          }
        }
        // Math.* / Number.* / Date.now() namespace calls -> static builtins.
        // Symbol-based: only treat `X.member()` as a builtin namespace call if
        // `X` actually resolves to the stdlib global (not a user binding that
        // shadows the name). `const Math = {...}; Math.f()` must NOT dispatch
        // to the real Math.
        if (ts.isIdentifier(fn.expression) && this.isAmbientGlobalSymbol(this.symbolOf(fn.expression))) {
          const ns = fn.expression.text;
          if (this.globalMemberMaybeMutated(ns, fn.name.text)) {
            return this.lowerGlobalMemberDynamicCall(ctx, ns, fn.name.text, node.arguments, this.refKindOf(node));
          }
          // Promise.resolve/reject(v) -> settled promise; Promise.all/race(arr) ->
          // combinator promise. allSettled/any are not yet implemented (loud-reject
          // rather than a bad dynamic dispatch).
          if (ns === "Promise") {
            const m = fn.name.text;
            if (m === "resolve" || m === "reject" || m === "all" || m === "race" || m === "allSettled" || m === "any") {
              const argL = node.arguments.length > 0
                ? this.lowerExpr(ctx, node.arguments[0])
                : (() => { const u = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } }); return u; })();
              const dst = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: `promise.${m}`, args: [argL] });
              return dst;
            }
            this.unsupported(node, `Promise.${m} not yet implemented (resolve/reject/all/race/allSettled/any only)`);
          }
          // Object.defineProperty(obj, key, descriptor): handle the common value
          // descriptor by setting the property. Accessor (get/set) descriptors and
          // the enumerable/writable/configurable attribute semantics are NOT
          // modeled by the flat prop map, so we reject those loudly rather than
          // silently producing a plain enumerable/writable property.
          if (ns === "Object" && fn.name.text === "defineProperty" && node.arguments.length === 3) {
            const desc = node.arguments[2];
            const obj = this.lowerExpr(ctx, node.arguments[0]);
            const key = this.lowerExpr(ctx, node.arguments[1]);
            if (!ts.isObjectLiteralExpression(desc)) {
              // Non-literal descriptor (a variable, call result, etc.): we can't
              // inspect its shape statically, so dispatch to the runtime form that
              // reads the descriptor's own properties at run time.
              const descLocal = this.lowerExpr(ctx, desc);
              ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
                builtin: "object.definePropertyDyn", args: [obj, key, descLocal] });
              return obj;
            }
            this.lowerDefineOneProperty(ctx, node, obj, key, desc);
            return obj;   // Object.defineProperty returns the object
          }
          // Object.create(proto, descriptors): the object with the prototype, then the
          // descriptors defined on it as Object.defineProperties does at run time.
          if (ns === "Object" && fn.name.text === "create" && node.arguments.length === 2) {
            const proto = this.lowerExpr(ctx, node.arguments[0]);
            const obj = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltinStatic", dst: obj, builtin: "object.create", args: [proto] });
            const descsLocal = this.lowerExpr(ctx, node.arguments[1]);
            ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
              builtin: "object.definePropertiesDyn", args: [obj, descsLocal] });
            return obj;
          }
          // Object.defineProperties(obj, { k1: desc1, ... }) — expand statically
          // when the map and each descriptor are literals; otherwise fall back to
          // the runtime form (which iterates the descriptor map at run time).
          if (ns === "Object" && fn.name.text === "defineProperties" && node.arguments.length === 2) {
            const descs = node.arguments[1];
            if (!ts.isObjectLiteralExpression(descs)) {
              const obj = this.lowerExpr(ctx, node.arguments[0]);
              const descsLocal = this.lowerExpr(ctx, descs);
              ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
                builtin: "object.definePropertiesDyn", args: [obj, descsLocal] });
              return obj;
            }
            // Literal map: if every entry is a literal `key: { ...descriptor }`,
            // expand statically (fast path). If any entry is dynamic, fall back to
            // the runtime form for the whole call (simpler + always correct).
            const allStatic = descs.properties.every(pr =>
              ts.isPropertyAssignment(pr) && (ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name)) &&
              ts.isObjectLiteralExpression(pr.initializer));
            const obj = this.lowerExpr(ctx, node.arguments[0]);
            if (!allStatic) {
              const descsLocal = this.lowerExpr(ctx, descs);
              ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
                builtin: "object.definePropertiesDyn", args: [obj, descsLocal] });
              return obj;
            }
            for (const pr of descs.properties) {
              const pa = pr as ts.PropertyAssignment;
              const keyLocal = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "Const", dst: keyLocal, value: { kind: "Str", value: (pa.name as ts.Identifier | ts.StringLiteral).text } });
              this.lowerDefineOneProperty(ctx, node, obj, keyLocal, pa.initializer as ts.ObjectLiteralExpression);
            }
            return obj;
          }
          // Variadic Math.max/min/hypot: seed with the identity and fold every arg
          // through the 2-arg runtime (which ToNumber-coerces and propagates NaN).
          // Handles 0 args (-> identity), 1 arg, and N args uniformly. Identity:
          // -Infinity (max), +Infinity (min), 0 (hypot — hypot(0,x)=|x|, hypot()=0).
          // Every argument expression is evaluated before the first conversion
          // (JS evaluates the argument list, then Math converts each value).
          // hypot of three or more values is not a fold of the 2-arg form (V8
          // normalizes all values together), so it takes the array form.
          if (ns === "Math" && (fn.name.text === "max" || fn.name.text === "min" || fn.name.text === "hypot")) {
            const seed: "NegInf" | "PosInf" | "Num" =
              fn.name.text === "max" ? "NegInf" : fn.name.text === "min" ? "PosInf" : "Num";
            const mb = `math.${fn.name.text}`;
            // Spread args (Math.max(...arr)) can't be folded statically: materialize
            // all args into an array and reduce it in the runtime.
            if (node.arguments.some((a) => ts.isSpreadElement(a)) ||
                (fn.name.text === "hypot" && node.arguments.length >= 3)) {
              const site = this.site++;
              this.recordSite(site, "array", this.inLoop(node) ? "many" : "once", false, node);
              const arrL = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "AllocArray", dst: arrL, elemType: 0, site });
              for (const a of node.arguments) {
                if (ts.isSpreadElement(a)) {
                  ctx.body.push({ kind: "ArrayPushAll", arr: arrL, src: this.lowerExpr(ctx, a.expression) });
                } else {
                  ctx.body.push({ kind: "ArrayPush", arr: arrL, src: this.lowerExpr(ctx, a) });
                }
              }
              const d = this.newLocal(ctx, "primitive");
              ctx.body.push({ kind: "CallBuiltinStatic", dst: d, builtin: `${mb}Arr`, args: [arrL] });
              return d;
            }
            const values = node.arguments.map((a) => this.lowerExpr(ctx, a));
            let acc = this.newLocal(ctx, "primitive");
            ctx.body.push({ kind: "Const", dst: acc, value: seed === "Num" ? { kind: "Num", value: 0 } : { kind: seed } });
            for (const next of values) {
              const d = this.newLocal(ctx, "primitive");
              ctx.body.push({ kind: "CallBuiltinStatic", dst: d, builtin: mb, args: [acc, next] });
              acc = d;
            }
            return acc;
          }
          // JSON.stringify(value, replacer?, space?): a null/undefined replacer routes to the
          // indenting runtime (a space argument) or the compact form; any other replacer (a
          // function, an array of names, or a value the runtime ignores as the spec does) goes to
          // the general form with the three arguments.
          if (ns === "JSON" && fn.name.text === "stringify" && node.arguments.length >= 2) {
            const replacer = node.arguments[1];
            const replacerIsNullish =
              replacer.kind === ts.SyntaxKind.NullKeyword ||
              (ts.isIdentifier(replacer) && replacer.text === "undefined");
            if (!replacerIsNullish) {
              const valLocal = this.lowerExpr(ctx, node.arguments[0]);
              const repLocal = this.lowerExpr(ctx, replacer);
              let spaceLocal: number;
              if (node.arguments.length >= 3) spaceLocal = this.lowerExpr(ctx, node.arguments[2]);
              else { spaceLocal = this.newLocal(ctx, "primitive"); ctx.body.push({ kind: "Const", dst: spaceLocal, value: { kind: "Undef" } }); }
              const dst = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "json.stringify.replacer", args: [valLocal, repLocal, spaceLocal] });
              return dst;
            }
            const valLocal = this.lowerExpr(ctx, node.arguments[0]);
            const dst = this.newLocal(ctx, "reference");
            if (node.arguments.length >= 3) {
              const spaceLocal = this.lowerExpr(ctx, node.arguments[2]);
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "json.stringify.indent", args: [valLocal, spaceLocal] });
            } else {
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "json.stringify", args: [valLocal] });
            }
            return dst;
          }
          if (ns === "JSON" && fn.name.text === "parse" && node.arguments.length === 1) {
            const text = node.arguments[0];
            if (ts.isStringLiteral(text) || ts.isNoSubstitutionTemplateLiteral(text)) {
              try {
                return this.lowerJsonConstValue(ctx, JSON.parse(text.text), node);
              } catch {
                /* Invalid JSON keeps the runtime path, which reports the parse error. */
              }
            }
          }
          const sname = this.namespaceBuiltin(ns, fn.name.text, node.arguments.length);
          if (sname !== undefined) {
            if (sname === "__UNSUPPORTED__") {
              this.unsupported(node, `${ns}.${fn.name.text} (not supported with ${node.arguments.length} args / not implemented)`);
            }
            const argLs = this.lowerSequenced(ctx, node.arguments);
            const numericResult = sname.startsWith("math.") || sname.endsWith("parseInt")
              || sname.endsWith("parseFloat") || sname === "number.coerce" || sname === "date.now";
            const dst = this.newLocal(ctx, numericResult ? "primitive" : "reference");
            ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: sname, args: argLs });
            return dst;
          }
        }
        // Date instance methods: getTime() / valueOf() -> read stored epoch-ms.
        if (fn.expression.kind !== ts.SyntaxKind.SuperKeyword) {
          const rt = this.typeNameOf(fn.expression);
          if (rt === "Date") {
            if (fn.name.text === "getTime" || fn.name.text === "valueOf") {
              const recv = this.lowerExpr(ctx, fn.expression);
              const dst = this.newLocal(ctx, "primitive");
              ctx.body.push({ kind: "LoadField", dst, obj: recv, field: this.DATE_MS_FIELD });
              return dst;
            }
            // Numeric component getters: read stored epoch-ms, then decompose via
            // ts_date_component(ms, selector). Local-time getters use the system TZ
            // (matching node on the same machine); UTC variants add 16.
            const dateComp: Record<string, number> = {
              getFullYear: 0, getMonth: 1, getDate: 2, getDay: 3,
              getHours: 4, getMinutes: 5, getSeconds: 6, getMilliseconds: 7,
              getTimezoneOffset: 8,
              getUTCFullYear: 16, getUTCMonth: 17, getUTCDate: 18, getUTCDay: 19,
              getUTCHours: 20, getUTCMinutes: 21, getUTCSeconds: 22, getUTCMilliseconds: 23,
            };
            if (Object.prototype.hasOwnProperty.call(dateComp, fn.name.text)) {
              const recv = this.lowerExpr(ctx, fn.expression);
              const msL = this.newLocal(ctx, "primitive");
              ctx.body.push({ kind: "LoadField", dst: msL, obj: recv, field: this.DATE_MS_FIELD });
              const selL = this.newLocal(ctx, "primitive");
              ctx.body.push({ kind: "Const", dst: selL, value: { kind: "Num", value: dateComp[fn.name.text] } });
              const dst = this.newLocal(ctx, "primitive");
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "date.component", args: [msL, selL] });
              return dst;
            }
            if (fn.name.text === "toJSON") {
              // Date.prototype.toJSON: the ISO string, null for an invalid date (its key argument is ignored)
              const recv = this.lowerExpr(ctx, fn.expression);
              const msL = this.newLocal(ctx, "primitive");
              ctx.body.push({ kind: "LoadField", dst: msL, obj: recv, field: this.DATE_MS_FIELD });
              const dst = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "date.toJSON", args: [msL] });
              return dst;
            }
            if (fn.name.text === "toISOString" || fn.name.text === "toUTCString") {
              const recv = this.lowerExpr(ctx, fn.expression);
              const msL = this.newLocal(ctx, "primitive");
              ctx.body.push({ kind: "LoadField", dst: msL, obj: recv, field: this.DATE_MS_FIELD });
              const dst = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: fn.name.text === "toISOString" ? "date.toISOString" : "date.toUTCString", args: [msL] });
              return dst;
            }
            if (fn.name.text === "toLocaleTimeString") {
              const recv = this.lowerExpr(ctx, fn.expression);
              const ms = this.newLocal(ctx, "primitive");
              ctx.body.push({ kind: "LoadField", dst: ms, obj: recv, field: this.DATE_MS_FIELD });
              const args = this.lowerSequenced(ctx, node.arguments);
              const dst = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "date.toLocaleTimeString", args: [ms, ...args] });
              return dst;
            }
            this.unsupported(node, `Date method '${fn.name.text}' (not implemented)`);
          }
          // (asyncgen).next() -> ts_asyncgen_next, returns a Promise<{value,done}>.
          if (fn.name.text === "next" && this.isAsyncGeneratorType(fn.expression)) {
            const recv = this.lowerExpr(ctx, fn.expression);
            const args = this.lowerSequenced(ctx, node.arguments);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltin", dst, builtin: "asyncgen.next", recv, args });
            return dst;
          }
          // gen.next(v) on a Generator/Iterator -> ts_gen_next, returns {value,done}.
          if (fn.name.text === "next" && this.isGeneratorType(fn.expression)) {
            const recv = this.lowerExpr(ctx, fn.expression);
            const args = this.lowerSequenced(ctx, node.arguments);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltin", dst, builtin: "generator.next", recv, args });
            return dst;
          }
          // (asyncgen).throw(e) -> ts_asyncgen_throw, returns a Promise<{value,done}>.
          if (fn.name.text === "throw" && this.isAsyncGeneratorType(fn.expression)) {
            const recv = this.lowerExpr(ctx, fn.expression);
            const args = this.lowerSequenced(ctx, node.arguments);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltin", dst, builtin: "asyncgen.throw", recv, args });
            return dst;
          }
          // (asyncgen).return(v) -> enqueue a return completion and return its
          // Promise<{value,done}>. The runtime serializes it with pending next/throw
          // requests and runs generator finally blocks before completion.
          if (fn.name.text === "return" && this.isAsyncGeneratorType(fn.expression)) {
            const recv = this.lowerExpr(ctx, fn.expression);
            const args = this.lowerSequenced(ctx, node.arguments);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltin", dst, builtin: "asyncgen.return", recv, args });
            return dst;
          }
          // gen.throw(e) on a Generator -> ts_gen_throw, returns {value,done}.
          if (fn.name.text === "throw" && this.isGeneratorType(fn.expression)) {
            const recv = this.lowerExpr(ctx, fn.expression);
            const args = this.lowerSequenced(ctx, node.arguments);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltin", dst, builtin: "generator.throw", recv, args });
            return dst;
          }
          // gen.return(v) on a Generator -> ts_gen_return, returns {value:v,done:true}.
          if (fn.name.text === "return" && this.isGeneratorType(fn.expression)) {
            const recv = this.lowerExpr(ctx, fn.expression);
            const args = this.lowerSequenced(ctx, node.arguments);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltin", dst, builtin: "generator.return", recv, args });
            return dst;
          }
        }
        // Object.getPrototypeOf(x) / Object.setPrototypeOf(x, p) builtins.
        if (ts.isIdentifier(fn.expression) && this.isBuiltinNamespaceRef(fn.expression, "Object")) {
          if (fn.name.text === "getPrototypeOf" && node.arguments.length >= 1) {
            const obj = this.lowerExpr(ctx, node.arguments[0]);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "GetProto", dst, obj });
            return dst;
          }
          if (fn.name.text === "setPrototypeOf" && node.arguments.length >= 2) {
            const obj = this.lowerExpr(ctx, node.arguments[0]);
            const proto = this.lowerProtoArg(ctx, node.arguments[1]);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "SetProto", dst, obj, proto });
            return dst;
          }
          if (fn.name.text === "is" && node.arguments.length >= 2) {
            // Object.is(a, b): SameValue — like ===, but -0 !== +0 and NaN === NaN.
            const a = this.lowerExpr(ctx, node.arguments[0]);
            const b = this.lowerExpr(ctx, node.arguments[1]);
            const dst = this.newLocal(ctx, this.refKindOf(node));
            ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "object.is", args: [a, b] });
            return dst;
          }
        }
        // obj.hasOwnProperty(key): own-property check (no prototype walk). Works
        // on any object; the key is interned at runtime by ts_has_own_dyn.
        if (fn.expression.kind !== ts.SyntaxKind.SuperKeyword &&
            fn.name.text === "hasOwnProperty" && node.arguments.length === 1) {
          const recv = this.lowerExpr(ctx, fn.expression);
          const key = this.lowerExpr(ctx, node.arguments[0]);
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "object.hasOwn", args: [recv, key] });
          return dst;
        }
        // sym.toString() -> "Symbol(desc)" for a symbol-typed receiver.
        if (fn.expression.kind !== ts.SyntaxKind.SuperKeyword && fn.name.text === "toString" &&
            node.arguments.length === 0) {
          try {
            const t = this.checker.getTypeAtLocation(fn.expression);
            if (t.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) {
              const recvL = this.lowerExpr(ctx, fn.expression);
              const dst = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "symbol.toString", args: [recvL] });
              return dst;
            }
          } catch { /* fall through */ }
        }
        // Standard-library String/Array methods -> runtime helpers (CallBuiltin).
        if (fn.expression.kind !== ts.SyntaxKind.SuperKeyword) {
          let cls = this.builtinReceiverKind(fn.expression);
          if (cls === undefined) {
            // a Map/Set-derived interface: only its builtin members take the collection path
            const dk = this.derivedCollectionKind(fn.expression);
            if (dk !== undefined && this.builtinMethodName2(dk, fn.name.text) !== undefined) cls = dk;
          }
          if (cls !== undefined) {
            const bname = this.builtinMethodName2(cls, fn.name.text);
            if (bname !== undefined) {
              if (cls === "string" && node.arguments.length >= 1 &&
                  (fn.name.text === "replace" || fn.name.text === "replaceAll" || fn.name.text === "split") &&
                  this.isRegExpExpr(node.arguments[0])) {
                this.unsupported(node, `String.prototype.${fn.name.text}(RegExp) not implemented`);
                return this.newLocal(ctx, "reference");
              }
              const recvL = this.lowerExpr(ctx, fn.expression);
              const argLs = this.lowerSequenced(ctx, node.arguments);
              // a collection lookup's key: the checker's kind of the key goes on
              // the key local as a hint for the emitter's inline probe
              if ((bname === "map.get" || bname === "map.has" || bname === "set.has") && argLs.length >= 1) {
                const kk = this.keyKindOfExpr(node.arguments[0]);
                const kl = ctx.locals[argLs[0]];
                if (kk !== undefined && kl && kl.tyKind === undefined) kl.tyKind = kk;
              }
              // Array.concat is variadic: fold each argument through the 2-arg
              // runtime (which spreads array args and appends non-array values).
              // No args -> a shallow copy of the receiver.
              if (bname === "array.concat") {
                let acc = recvL;
                for (const argL of argLs) {
                  const d = this.newLocal(ctx, "reference");
                  ctx.body.push({ kind: "CallBuiltin", dst: d, builtin: "array.concat", recv: acc, args: [argL] });
                  acc = d;
                }
                if (argLs.length === 0) {
                  const d = this.newLocal(ctx, "reference");
                  ctx.body.push({ kind: "CallBuiltin", dst: d, builtin: "array.slice", recv: acc, args: [] });
                  return d;
                }
                return acc;
              }
              // String.concat is variadic: fold each argument (string immutable,
              // so 0 args just returns the receiver).
              if (bname === "string.concat") {
                let acc = recvL;
                for (const argL of argLs) {
                  const d = this.newLocal(ctx, "reference");
                  ctx.body.push({ kind: "CallBuiltin", dst: d, builtin: "string.concat", recv: acc, args: [argL] });
                  acc = d;
                }
                return acc;
              }
              // Array.splice(start, deleteCount?, ...items): variadic insertion.
              // Build the items array, then route to the runtime. Arg-count rules:
              //   0 args -> delete nothing; 1 arg -> delete to end; >=2 -> deleteCount given.
              if (bname === "array.splice") {
                // A splice whose result is discarded (an expression statement):
                // `a.splice(i, 0, x)` inserts in place with no items array and no
                // removed array; any other form skips the removed array.
                // TSAOT_SPLICE_FAST=0 keeps the general builtin (parity oracle).
                const discarded = this.spliceFast && ts.isExpressionStatement(node.parent);
                if (discarded && argLs.length === 3 && ts.isNumericLiteral(node.arguments[1]) && node.arguments[1].text === "0" &&
                    !ts.isSpreadElement(node.arguments[2])) {
                  const dst = this.newLocal(ctx, "reference");
                  ctx.body.push({ kind: "CallBuiltin", dst, builtin: "array.spliceInsert1", recv: recvL, args: [argLs[0], argLs[2]] });
                  return dst;
                }
                const site = this.site++;
                this.recordSite(site, "array", this.inLoop(node) ? "many" : "once", false, node);
                const itemsArr = this.newLocal(ctx, "reference");
                ctx.body.push({ kind: "AllocArray", dst: itemsArr, elemType: 0, site });
                for (let i = 2; i < argLs.length; i++) {
                  ctx.body.push({ kind: "ArrayPush", arr: itemsArr, src: argLs[i] });
                }
                const constNum = (val: number): number => {
                  const c = this.newLocal(ctx, "primitive");
                  ctx.body.push({ kind: "Const", dst: c, value: { kind: "Num", value: val } });
                  return c;
                };
                const dst = this.newLocal(ctx, "reference");
                if (argLs.length === 1) {
                  ctx.body.push({ kind: "CallBuiltin", dst, builtin: "array.spliceEnd", recv: recvL, args: [argLs[0], itemsArr] });
                } else {
                  const startL = argLs.length > 0 ? argLs[0] : constNum(0);
                  const dcL = argLs.length > 1 ? argLs[1] : constNum(0);
                  ctx.body.push({ kind: "CallBuiltin", dst, builtin: discarded ? "array.spliceDrop" : "array.splice", recv: recvL, args: [startL, dcL, itemsArr] });
                }
                return dst;
              }
              // Array.toSpliced(start, deleteCount?, ...items): the change-by-copy
              // form of splice — same variadic items handling and the same arg-count
              // rules, but returns a NEW array (the runtime leaves the receiver
              // intact). Mirrors the array.splice branch above, including the 1-arg
              // "delete to end" form routed through a separate End builtin (has_dc=0).
              if (bname === "array.toSpliced") {
                const site = this.site++;
                this.recordSite(site, "array", this.inLoop(node) ? "many" : "once", false, node);
                const itemsArr = this.newLocal(ctx, "reference");
                ctx.body.push({ kind: "AllocArray", dst: itemsArr, elemType: 0, site });
                for (let i = 2; i < argLs.length; i++) {
                  ctx.body.push({ kind: "ArrayPush", arr: itemsArr, src: argLs[i] });
                }
                const constNum = (val: number): number => {
                  const c = this.newLocal(ctx, "primitive");
                  ctx.body.push({ kind: "Const", dst: c, value: { kind: "Num", value: val } });
                  return c;
                };
                const dst = this.newLocal(ctx, "reference");
                if (argLs.length === 1) {
                  ctx.body.push({ kind: "CallBuiltin", dst, builtin: "array.toSplicedEnd", recv: recvL, args: [argLs[0], itemsArr] });
                } else {
                  const startL = argLs.length > 0 ? argLs[0] : constNum(0);
                  const dcL = argLs.length > 1 ? argLs[1] : constNum(0);
                  ctx.body.push({ kind: "CallBuiltin", dst, builtin: "array.toSpliced", recv: recvL, args: [startL, dcL, itemsArr] });
                }
                return dst;
              }
              const numericResult = bname === "string.indexOf" || bname === "string.charCodeAt"
                || bname === "array.indexOf" || bname === "array.push"
                || bname === "array.findIndex" || bname === "array.lastIndexOf"
                || bname === "array.unshift";
              const dst = this.newLocal(ctx, numericResult ? "primitive" : "reference");
              ctx.body.push({ kind: "CallBuiltin", dst, builtin: bname, recv: recvL, args: argLs });
              return dst;
            }
            // A method on a known builtin string/array type that we don't yet
            // implement: reject loudly rather than silently miscompiling/trapping.
            this.unsupported(node, `${cls} method '${fn.name.text}' (stdlib method not yet implemented)`);
          }
        }
        // super.staticMethod(...) inside a STATIC body -> Direct call to the parent's
        // static method (walking the chain), passing the current receiver as `this`
        // so the parent method's `this.X` reads the subclass's static view.
        if (fn.expression.kind === ts.SyntaxKind.SuperKeyword && ctx.staticClass !== undefined && ctx.thisLocal !== undefined) {
          const parent = this.parentIdOf(ctx.staticClass);
          const sm = parent !== undefined ? this.resolveStaticMethod(parent, fn.name.text) : undefined;
          if (sm !== undefined) {
            const argLs = this.lowerSequenced(ctx, node.arguments);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "Call", dst, callee: { kind: "Direct", func: sm.fnId }, args: [ctx.thisLocal, ...argLs] });
            return dst;
          }
        }
        // super.m(...) : statically the parent's resolution -> Direct (no devirt).
        // A dynamic class on the path from the parent to the declaring class
        // (its prototype may have been written, relinked or had the method
        // deleted) makes the lookup a runtime one from the home object's
        // prototype (docs/conformance_fixes.md, "super calls through a
        // dynamic parent").
        if (fn.expression.kind === ts.SyntaxKind.SuperKeyword && ctx.currentClass !== undefined) {
          const parent = this.parentIdOf(ctx.currentClass);
          const func = parent !== undefined ? this.resolveMemberFunc(parent, fn.name.text, "method") : undefined;
          if (func !== undefined) {
            const mv = parent !== undefined && this.superPathIsDynamic(parent, fn.name.text)
              ? this.lowerDynamicSuperMethod(ctx, fn.name.text) : undefined;
            callee = mv !== undefined ? { kind: "Value", local: mv } : { kind: "Direct", func };
            recv = ctx.thisLocal; // super call runs the parent method on the same `this`
          }
        } else {
          recv = this.lowerExpr(ctx, fn.expression);
          // sequence-point eval: if an argument may mutate the receiver variable,
          // snapshot the receiver (a bare-var read aliases its slot) before the
          // args are lowered below (`obj.m(i, obj = x)`).
          if (recv !== undefined && this.isMutableStorageLocal(ctx, recv) &&
              node.arguments.some((a) => this.mayHaveSideEffect(a))) {
            const s = this.newLocal(ctx, this.refKindOf(fn.expression));
            ctx.body.push({ kind: "Copy", dst: s, src: recv });
            recv = s;
          }
          // `m.call(x, ...)` through a module-level `const m = Object.prototype.hasOwnProperty / toString`
          // (vue's `hasOwn` and `toTypeString`, lodash's `objectToString`): the runtime's implementation,
          // without the function value and its argument vector
          if (fn.name.text === "call" && ts.isIdentifier(fn.expression) && !node.arguments.some((a) => ts.isSpreadElement(a))) {
            const aliasSym = this.symbolOf(fn.expression);
            const alias = aliasSym ? this.constProtoMethodAliases.get(aliasSym) : undefined;
            const builtin = alias === "hasOwnProperty" && node.arguments.length === 2 ? "object.hasOwn"
              : alias === "toString" && node.arguments.length === 1 ? "objproto.toStringCall" : undefined;
            if (builtin !== undefined && recv !== undefined) {
              this.checkClassBindingInitialized(ctx, fn.expression, recv);
              const argLs = this.lowerSequenced(ctx, node.arguments);
              const dst = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin, args: argLs });
              return dst;
            }
          }
          // `f.call(thisArg, ...args)` / `f.apply(thisArg, arr)` where the receiver's type names
          // Function.prototype's member (a function-typed value: rxjs's `project.call(thisArg, value, index)`
          // in map and filter): the runtime's implementations directly. The generic path read `call`
          // through the function's prototype chain on every call (5.9 M out-of-line reads in the rxjs
          // driver). A spread argument keeps the generic path.
          if ((fn.name.text === "call" || fn.name.text === "apply") && !node.arguments.some((a) => ts.isSpreadElement(a)) &&
              this.classExtractor.isFunctionProtoCallOrApply(this.checker.getSymbolAtLocation(fn.name))) {
            const argLs = this.lowerSequenced(ctx, node.arguments);
            const dst = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: `function.${fn.name.text}`, args: [recv as number, ...argLs] });
            return dst;
          }
          // If the receiver's static type is a known class and the member is one
          // of its methods, emit a Method callee for the devirt pass to resolve.
          // EXCEPTION: if the class (or an ancestor) also declares an INSTANCE
          // FIELD of the same name, that field shadows the prototype method per
          // JS own->prototype order (e.g. `class D extends B { greet = () => 1 }`
          // over `class B { greet(){...} }`). Static devirt would wrongly call the
          // prototype method, so we fall to the dynamic path (recvClass sentinel),
          // whose own(field-key)->prototype(method-key) lookup honors the shadow.
          const recvClass = this.classOfExpr(fn.expression);
          const fieldShadows = recvClass !== undefined && this.classHasField(recvClass, fn.name.text);
          if (recvClass !== undefined && this.classHasMethod(recvClass, fn.name.text) && !fieldShadows) {
            callee = {
              kind: "Method",
              recvClass,
              method: this.internName(fn.name.text),
              recvStable: this.classExtractor.recvStableAt(fn.expression),
              methodField: this.internField(fn.name.text),
            };
          } else {
            // Unknown/any receiver OR field-shadowed method: record the method NAME
            // so codegen does a faithful own->prototype lookup on the dynamic path.
            // A sentinel recvClass (-1) makes devirt fall to Dynamic while keeping
            // the name. methodField lets the dynamic path try the OWN property
            // (field-key) first (object-literal methods, `{g: fn}`, own-field
            // shadowing) before the prototype method-key.
            callee = {
              kind: "Method",
              recvClass: 0xffffffff,
              method: this.internName(fn.name.text),
              recvStable: false,
              methodField: this.internField(fn.name.text),
            };
          }
        }
      }
      // o[k](...) is a member call: per JS it binds `this` to the BASE object.
      // Evaluate the base once, load the member off it, and call with recv=base
      // (codegen routes a Value callee that has a receiver through ts_call_method,
      // so the base lands as `this`). This is the natural call form for a
      // dynamic/symbol-keyed method `c[k]()` / `c[sym]()`.
      if (callee.kind === "Unknown" && recv === undefined && ts.isElementAccessExpression(fn)) {
        const baseL = this.lowerExpr(ctx, fn.expression);
        const argExpr = fn.argumentExpression;
        const fnVal = this.newLocal(ctx, "reference");
        if (this.isSymbolKeyExpr(argExpr)) {
          const symLocal = this.lowerExpr(ctx, argExpr);
          ctx.body.push({ kind: "CallBuiltinStatic", dst: fnVal, builtin: "symbol.get", args: [baseL, symLocal] });
        } else if (this.indexAccessKind(fn) === "string") {
          const key = this.lowerExpr(ctx, argExpr);
          ctx.body.push({ kind: "LoadFieldDynamic", dst: fnVal, obj: baseL, key });
        } else {
          const idx = this.lowerExpr(ctx, argExpr);
          ctx.body.push({ kind: "LoadIndex", dst: fnVal, arr: baseL, index: idx });
        }
        callee = { kind: "Value", local: fnVal };
        recv = baseL;
      }
      // Fallback: the callee is an arbitrary expression that yields a function
      // value (e.g. `getFn()(x)`, or `f.bind(o)(x)` where bind returns a
      // function). Lower it to a value and call through it.
      if (callee.kind === "Unknown" && recv === undefined &&
          !ts.isIdentifier(fn) && !ts.isPropertyAccessExpression(fn) &&
          fn.kind !== ts.SyntaxKind.SuperKeyword) {
        const vloc = this.lowerExpr(ctx, fn);
        if (vloc !== undefined) callee = { kind: "Value", local: vloc };
      }
      const hasSpread = node.arguments.some((a) => ts.isSpreadElement(a));
      if (callee.kind === "Direct" && recv === undefined) {
        const target = this.fnNodeById(callee.func);
        const unavailable = target && this.sortedFreeVars(target as FnLike).some((s) =>
          !this.hasCaptured(ctx, s) && !this.moduleCellGlobal.has(s) &&
          !(this.valueBindings.has(s) && ctx.localOfSymbol.has(s)));
        // Fixed-ABI helpers may not hold every module cell. The already-created
        // function value carries the environment. It also supplies captured
        // arguments and `this` correctly when the call has a spread list.
        if (hasSpread || unavailable) {
          const value = this.directFunctionValue(ctx, callee.func);
          if (value !== undefined) callee = { kind: "Value", local: value };
        }
      }
      if (hasSpread) {
        if (callee.kind === "Value" && this.isMutableStorageLocal(ctx, callee.local)) {
          const snapshot = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Copy", dst: snapshot, src: callee.local });
          callee = { kind: "Value", local: snapshot };
        }
        const argSpecs = this.lowerSpreadArguments(ctx, node.arguments);
        const dst = this.newLocal(ctx, this.refKindOf(node));
        const inst: any = { kind: "CallSpread", dst, callee, argSpecs };
        if (recv !== undefined) inst.recv = recv;
        ctx.body.push(inst);
        return dst;
      }
      const args = this.lowerSequenced(ctx, droppedCallbackArgs
        ? node.arguments.filter((_, i) => !droppedCallbackArgs!.has(i))
        : node.arguments);
      const dst = this.newLocal(ctx, this.refKindOf(node));
      // The callee's parameter layout is [cells..., this, real params] (Step C /
      // AllocClosure). Both prepends below unshift, so they run in REVERSE of
      // that layout: first the `this` slot, then the captured cells in front.
      //
      // A direct call to a function declared with an explicit `this` parameter
      // (or an ES5 body reading its own `this`) expects a this slot. A plain call
      // `f(1,2)` (no receiver) supplies no this, so JS makes `this` undefined:
      // prepend an undefined this slot so the remaining args land in the right
      // positions. (Method calls set `recv` and are handled separately;
      // call/apply/bind inject thisArg via the runtime.)
      if (callee && (callee as any).kind === "Direct" && recv === undefined &&
          this.funcTakesThisIds.has((callee as any).func)) {
        const undefThis = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: undefThis, value: { kind: "Undef" } });
        args.unshift(undefThis);
      }
      // Step C: a Direct call to a top-level function that captures module
      // cells must pass those cells as leading arguments. The caller holds the
      // same cells in its own cellAccess (it captures the same module bindings).
      // Without this the callee reads an empty cell -> NaN.
      if (callee && (callee as any).kind === "Direct" && recv === undefined) {
        const cells = this.directCallCellArgs(ctx, (callee as any).func);
        if (cells.length) args.unshift(...cells);
      }
      const inst: any = { kind: "Call", dst, callee, args };
      if (recv !== undefined) inst.recv = recv;
      ctx.body.push(inst);
      return dst;
    }
    // instanceof: resolved at compile time from the LHS's static class and the
    // RHS class name. x instanceof C  ->  true iff x's static class is C or a
    // subclass of C. Undecidable cases (unknown class, dynamic) error loudly.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      // Step G: `#field in obj` — private-name brand check. The LHS is a
      // PrivateIdentifier; HasField on the private field name (#field) tests
      // whether obj carries that brand (i.e. is an instance of the declaring
      // class). Field name (#field) is consistent with how private fields are
      // stored (internField uses the same #-prefixed text).
      if (ts.isPrivateIdentifier(node.left)) {
        const obj = this.lowerExpr(ctx, node.right);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "HasField", dst, obj, field: this.internField(node.left.text) });
        return dst;
      }
      // "key" in obj : with a string-literal key we know the field id statically.
      if (ts.isStringLiteral(node.left)) {
        const obj = this.lowerExpr(ctx, node.right);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "HasField", dst, obj, field: this.internField(node.left.text) });
        return dst;
      }
      // dynamic key (string-valued expression): intern at runtime.
      const key = this.lowerExpr(ctx, node.left);
      const obj = this.lowerExpr(ctx, node.right);
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "HasFieldDynamic", dst, obj, key });
      return dst;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const lclass = this.classOfExpr(node.left);
      let rclass: number | undefined;
      if (ts.isIdentifier(node.right)) {
        // an imported class is read through its import alias
        const sym = this.checker.getSymbolAtLocation(node.right);
        if (sym) rclass = this.classSymToId.get(this.unwrapImportAlias(sym) ?? sym);
      }
      const dst = this.newLocal(ctx, "reference");
      // Symbol.hasInstance hook: `x instanceof C` calls C[Symbol.hasInstance](x)
      // and ToBooleans the result. This OVERRIDES the ordinary proto-walk, so it
      // takes precedence over the staticallyTrue shortcut below. The hook lives on
      // C's static container (proto-linked, so an inherited hook resolves too).
      if (rclass !== undefined && this.classHasHasInstanceHook(rclass)) {
        const obj = this.lowerExpr(ctx, node.left);
        const cc = this.staticContainerClassOf(rclass)!; // has-or-inherits statics => has a container
        const container = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadGlobal", dst: container, gref: this.classStaticGlobal.get(cc)! });
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "instanceof.hook", args: [container, obj] });
        return dst;
      }
      // Built-in RHS (`x instanceof Error/Map/WeakMap/...`): not a user class
      // (rclass undefined), so check obj's prototype chain against the shared
      // runtime prototype. (instanceof.dyn can't help: built-in constructors carry
      // no class_id.)
      if (rclass === undefined && ts.isIdentifier(node.right) &&
          this.isBuiltinSymbol(this.checker.getSymbolAtLocation(node.right))) {
        if (node.right.text === "Date") {
          // A Date is a plain object carrying the internal `__date_ms` field (the
          // `new Date` lowering): the field's presence is the instanceof answer.
          const obj = this.lowerExpr(ctx, node.left);
          ctx.body.push({ kind: "HasField", dst, obj, field: this.DATE_MS_FIELD });
          return dst;
        }
        const ek = this.errorKindIndex(node.right.text);
        const builtinProtoKinds: Record<string, string> = {
          Object: "object",
          RegExp: "regexp",
          Map: "map",
          Set: "set",
          WeakMap: "weakmap",
          WeakSet: "weakset",
          Promise: "promise",
        };
        const taElem = TYPED_ARRAY_ELEMS.get(node.right.text);
        if (taElem !== undefined) builtinProtoKinds[node.right.text] = `typedarray:${taElem}`;
        if (node.right.text === "ArrayBuffer") builtinProtoKinds.ArrayBuffer = "arraybuffer";
        if (node.right.text === "SharedArrayBuffer") builtinProtoKinds.SharedArrayBuffer = "sharedarraybuffer";
        if (node.right.text === "TextEncoder") builtinProtoKinds.TextEncoder = "textencoder";
        if (node.right.text === "TextDecoder") builtinProtoKinds.TextDecoder = "textdecoder";
        // The shared prototype object to chain-check against.
        const protoBuiltin =
          ek !== undefined ? `errorproto.${ek}` :
          Object.prototype.hasOwnProperty.call(builtinProtoKinds, node.right.text)
            ? `protoobj.${builtinProtoKinds[node.right.text]}`
            : undefined;
        if (protoBuiltin !== undefined) {
          const obj = this.lowerExpr(ctx, node.left);
          const proto = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadBuiltinFn", dst: proto, builtin: protoBuiltin });
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "instanceof", args: [obj, proto] });
          return dst;
        }
      }
      // Decide at compile time ONLY when the static class proves the result:
      //   lclass is rclass or a subclass of rclass  =>  definitely true.
      // If lclass is a *parent* of rclass (or unrelated), the runtime value may
      // still be a subclass of rclass, so we MUST check at runtime — a static
      // `false` would be wrong (e.g. `a: Animal = new Dog(); a instanceof Dog`).
      // A COLLAPSED polymorphic value (`const K = cond ? A : B` with A,B structurally
      // identical) has lclass = one member, but its runtime class may be the other —
      // so the static `instanceof` answer is unsound. Suppress the shortcut and emit
      // the always-correct runtime proto-walk for such LHSs.
      // (only along stable classes: a program that relinks a class prototype,
      // `Object.setPrototypeOf(C.prototype, X)`, changes the answer)
      let staticallyTrue = false;
      if (lclass !== undefined && rclass !== undefined && !this.exprMayBePolyInstance(node.left)) {
        let cur: number | undefined = lclass;
        while (cur !== undefined) {
          if (!this.classInfos[cur]?.stable) break;
          if (cur === rclass) { staticallyTrue = true; break; }
          cur = this.parentIdOf(cur);
        }
      }
      if (staticallyTrue) {
        this.lowerExpr(ctx, node.left);   // evaluate LHS for side effects
        ctx.body.push({ kind: "Const", dst, value: { kind: "Bool", value: true } });
      } else if (rclass !== undefined) {
        // runtime prototype-chain check: obj instanceof C iff C.prototype is in
        // obj's prototype chain (subclasses chain their protos to the parent).
        const obj = this.lowerExpr(ctx, node.left);
        const klass = this.lowerExpr(ctx, node.right);
        if (this.sharedClassProto(rclass) && process.env.TSAOT_INSTANCEOF_CLASS !== "0") {
          // A class declaration evaluated once has one prototype, the
          // registered one: no read of the class value's `prototype`.
          this.checkClassBindingInitialized(ctx, node.right, klass);
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: `instanceof.class:${rclass}`, args: [obj, klass] });
        } else {
          const proto = this.loadClassValuePrototype(ctx, klass);
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "instanceof", args: [obj, proto] });
        }
      } else {
        // RHS is a runtime constructor VALUE (a class held in a variable/parameter,
        // or a conditional like `cond ? A : B`). Lower left then right (JS eval order)
        // and dispatch to the runtime, which consults Symbol.hasInstance then walks
        // the prototype chain against the class value's prototype. Gate on the RHS
        // static type having construct signatures (union-aware) so a non-constructor
        // RHS (an `any` value, a plain value) still loud-rejects rather than silently
        // returning false.
        let isCtorVal = false;
        try {
          const rt = this.checker.getTypeAtLocation(node.right);
          const hasCtor = (t: ts.Type): boolean =>
            t.getConstructSignatures().length > 0 || (t.isUnion() && t.types.every(hasCtor));
          isCtorVal = hasCtor(rt);
          // ES5 function constructor RHS (`x instanceof Foo` where Foo is a plain
          // function), or an `any`-typed RHS: callable/any, non-builtin ->
          // instanceof.dyn. The runtime walks fn.prototype and throws V8's
          // TypeError for a prototype-less function (arrow/method) or a
          // non-callable value, so a bad RHS is still loud (catchable).
          // (a builtin constructor the static branches above did not take, `BigInt` behind a
          // `typeof BigInt !== "undefined"` guard, goes the same way: the runtime's check of the value)
          if (!isCtorVal) {
            // union-aware too: a conditional's constructor-or-function type (`f ? C : Math.max`)
            const callable = (t: ts.Type): boolean =>
              t.getCallSignatures().length > 0 || t.getConstructSignatures().length > 0 || (t.flags & ts.TypeFlags.Any) !== 0 ||
              (t.isUnion() && t.types.every(callable));
            isCtorVal = callable(rt);
          }
          // An object with a `[Symbol.hasInstance]` method (a constructor object such as
          // lib/node's Buffer): the runtime calls the hook.
          if (!isCtorVal) {
            const hasHook = (t: ts.Type): boolean =>
              t.getProperties().some((p) => p.name.startsWith("__@hasInstance")) || (t.isUnion() && t.types.every(hasHook));
            isCtorVal = hasHook(rt);
          }
        } catch { /* leave false */ }
        if (isCtorVal) {
          const obj = this.lowerExpr(ctx, node.left);
          const ctor = this.lowerExpr(ctx, node.right);
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "instanceof.dyn", args: [obj, ctor] });
        } else {
          this.unsupported(node, "instanceof with non-static right-hand class (runtime constructor value not yet modeled)");
        }
      }
      return dst;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = this.unwrapAssignTarget(node.left);
      // JS evaluates the assignment TARGET reference before the RHS. For element
      // access and plain-field property access (the targets with runtime
      // object/key), pre-evaluate object/key first and snapshot them if the RHS
      // may mutate them — fixes `a[i]=i++`, `a[key()]=i`, `o.x=(o=…)`. Other
      // targets (identifier / static field / prototype / setter) are eval-order
      // insensitive, so keep the simple rhs-first path.
      // `re.lastIndex = v` on a receiver typed RegExp: the receiver first, then the value,
      // then the slot write (`regexp.setLastIndex`)
      if (ts.isPropertyAccessExpression(lhs) && lhs.name.text === "lastIndex" && this.isRegExpExpr(lhs.expression)) {
        const recv = this.lowerExpr(ctx, lhs.expression);
        const rhs = this.lowerExpr(ctx, node.right);
        ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "regexp.setLastIndex", args: [recv, rhs] });
        return rhs;
      }
      if (ts.isElementAccessExpression(lhs) ||
          (ts.isPropertyAccessExpression(lhs) && this.isPlainFieldStoreTarget(lhs))) {
        const pre = this.lowerAssignRefPre(ctx, lhs, this.mayHaveSideEffect(node.right));
        const rhs = this.lowerExpr(ctx, node.right);
        this.lowerAssignTarget(ctx, lhs, rhs, pre);
        return rhs;
      }
      if (ts.isArrayLiteralExpression(lhs)) {
        // `[a, b = 1, ...rest] = <iterable>`: an iterator source is stepped by the protocol
        const source = this.iterablePatternSource(ctx, node.right);
        if (source !== undefined && !("drv" in source)) { this.lowerAssignTarget(ctx, lhs, source.array); return source.source; }
        if (source !== undefined && "drv" in source) {
          const drv = source.drv;
          this.lowerArrayPatternByProtocol(ctx, drv, lhs.elements.map((el): IterPatternElement => ({
            node: el,
            omitted: ts.isOmittedExpression(el),
            rest: ts.isSpreadElement(el),
            bind: (v: number) => {
              if (ts.isOmittedExpression(el)) return;
              if (ts.isSpreadElement(el)) { this.lowerAssignTarget(ctx, el.expression, v); return; }
              let target: ts.Expression = el;
              if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                const isUndef = this.newLocal(ctx, "primitive");
                ctx.body.push({ kind: "UnOp", dst: isUndef, op: "isundef", operand: v });
                const thenB = this.captureBody(ctx, () => {
                  const dv = this.lowerExpr(ctx, el.right);
                  ctx.body.push({ kind: "Copy", dst: v, src: dv });
                });
                ctx.body.push({ kind: "If", cond: isUndef, thenBody: thenB, elseBody: [] });
                target = el.left;
              }
              this.lowerAssignTarget(ctx, target, v);
            },
          })));
          return drv.srcLocal;
        }
      }
      const rhs = this.lowerExpr(ctx, node.right);
      this.lowerAssignTarget(ctx, lhs, rhs);
      return rhs;
    }
    // compound assignment: x op= y  ->  x = x op y
    {
      const compound: Record<number, string> = {
        [ts.SyntaxKind.PlusEqualsToken]: "+", [ts.SyntaxKind.MinusEqualsToken]: "-",
        [ts.SyntaxKind.AsteriskEqualsToken]: "*", [ts.SyntaxKind.SlashEqualsToken]: "/",
        [ts.SyntaxKind.PercentEqualsToken]: "%",
        [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: "**",
        [ts.SyntaxKind.AmpersandEqualsToken]: "&", [ts.SyntaxKind.BarEqualsToken]: "|",
        [ts.SyntaxKind.CaretEqualsToken]: "^",
        [ts.SyntaxKind.LessThanLessThanEqualsToken]: "<<",
        [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ">>",
        [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ">>>",
      };
      if (ts.isBinaryExpression(node) && compound[node.operatorToken.kind]) {
        const op = compound[node.operatorToken.kind];
        const lhs = this.unwrapAssignTarget(node.left);
        // Element access and plain-field property access carry a runtime target
        // reference (object/key) that JS evaluates EXACTLY ONCE, shared by the
        // read and the write-back. Lowering read and write separately would
        // re-evaluate it, so `a[i++] += 5` increments i twice and reads/writes
        // different slots (silent miscompile); `getObj().x += 5` calls getObj()
        // twice. Evaluate the ref first (snapshotting bare obj/key when the RHS
        // may mutate them, JS captures the target before the RHS), read through
        // it, then write back through the SAME ref. Identifier / static field /
        // prototype targets have no double-eval hazard, so keep the simple path.
        let useRef = ts.isElementAccessExpression(lhs);
        if (ts.isPropertyAccessExpression(lhs) && this.isPlainFieldStoreTarget(lhs)) {
          const gClass = this.classOfExpr(lhs.expression);
          // a getter-backed property reads via a method call, not a field load;
          // leave those to the simple path (accessor handling is a separate gap).
          if (!(gClass !== undefined && this.hasGetter(gClass, lhs.name.text))) useRef = true;
        }
        if (useRef) {
          const pre = this.lowerAssignRefPre(ctx, lhs, this.mayHaveSideEffect(node.right));
          const cur = this.lowerReadFromRef(ctx, lhs, pre);
          const rhs = this.lowerExpr(ctx, node.right);
          const res = this.newLocal(ctx, this.refKindOf(node));
          ctx.body.push({ kind: "BinOp", dst: res, op, lhs: cur, rhs });
          this.lowerAssignTarget(ctx, lhs, res, pre);
          return res;
        }
        const cur = this.lowerExpr(ctx, node.left);
        const rhs = this.lowerExpr(ctx, node.right);
        const res = this.newLocal(ctx, this.refKindOf(node));
        ctx.body.push({ kind: "BinOp", dst: res, op, lhs: cur, rhs });
        this.lowerAssignTarget(ctx, node.left, res);
        return res;
      }
    }
    // logical-assignment: a &&= b / a ||= b / a ??= b. Short-circuit: only
    // evaluate & assign `b` when the guard requires it (truthy/falsy/nullish of a).
    if (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
         node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
         node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)) {
      const kind = node.operatorToken.kind;
      const cur = this.lowerExpr(ctx, node.left);
      const res = this.newLocal(ctx, this.refKindOf(node));
      ctx.body.push({ kind: "Copy", dst: res, src: cur });
      const assignBody = this.captureBody(ctx, () => {
        const rhs = this.lowerExpr(ctx, node.right);
        ctx.body.push({ kind: "Copy", dst: res, src: rhs });
        this.lowerAssignTarget(ctx, node.left, rhs);
      });
      if (kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
        // a &&= b : assign b only if a is truthy
        ctx.body.push({ kind: "If", cond: cur, thenBody: assignBody, elseBody: [] });
      } else if (kind === ts.SyntaxKind.BarBarEqualsToken) {
        // a ||= b : assign b only if a is falsy
        ctx.body.push({ kind: "If", cond: cur, thenBody: [], elseBody: assignBody });
      } else {
        // a ??= b : assign b only if a is null/undefined
        const isNull = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "UnOp", dst: isNull, op: "nullish", operand: cur });
        ctx.body.push({ kind: "If", cond: isNull, thenBody: assignBody, elseBody: [] });
      }
      return res;
    }
    // logical short-circuit: && || ??  -> If-guarded evaluation into a result local
    if (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
         node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      const kind = node.operatorToken.kind;
      if (kind !== ts.SyntaxKind.QuestionQuestionToken) {
        // a build-time constant on the left (`__DEV__ && warn(...)`): the side JS evaluates
        const decided = this.constCondValue(node.left);
        if (decided !== undefined) {
          const takesRight = kind === ts.SyntaxKind.AmpersandAmpersandToken ? decided : !decided;
          return this.lowerExpr(ctx, takesRight ? node.right : node.left);
        }
      }
      const res = this.newLocal(ctx, this.refKindOf(node));
      const lhs = this.lowerExpr(ctx, node.left);
      ctx.body.push({ kind: "Copy", dst: res, src: lhs });
      const rhsBody = this.captureBody(ctx, () => {
        const rhs = this.lowerExpr(ctx, node.right);
        ctx.body.push({ kind: "Copy", dst: res, src: rhs });
      });
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        // && : res starts as lhs; if lhs truthy, overwrite with rhs
        ctx.body.push({ kind: "If", cond: lhs, thenBody: rhsBody, elseBody: [] });
      } else if (kind === ts.SyntaxKind.BarBarToken) {
        // || : res starts as lhs; if lhs falsy, overwrite with rhs
        ctx.body.push({ kind: "If", cond: lhs, thenBody: [], elseBody: rhsBody });
      } else {
        // ?? : overwrite with rhs ONLY if lhs is null/undefined (not merely falsy,
        // so 0 ?? x === 0). Test via a dedicated nullish UnOp (keeps lhs boxed).
        const isNull = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "UnOp", dst: isNull, op: "nullish", operand: lhs });
        ctx.body.push({ kind: "If", cond: isNull, thenBody: rhsBody, elseBody: [] });
      }
      return res;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // comma operator: evaluate left (for side effects, discard), return right.
      this.lowerExpr(ctx, node.left);
      return this.lowerExpr(ctx, node.right);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const concatParts = this.flattenStringConcatMany(node);
      if (concatParts) {
        const args = this.lowerSequenced(ctx, concatParts);
        const dst = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "string.concatMany", args });
        return dst;
      }
    }
    if (ts.isBinaryExpression(node)) {
      // arithmetic / comparison operators -> a BinOp producing a value
      const opMap: Record<number, string> = {
        [ts.SyntaxKind.PlusToken]: "+", [ts.SyntaxKind.MinusToken]: "-",
        [ts.SyntaxKind.AsteriskToken]: "*", [ts.SyntaxKind.SlashToken]: "/",
        [ts.SyntaxKind.PercentToken]: "%",
        [ts.SyntaxKind.LessThanToken]: "<", [ts.SyntaxKind.LessThanEqualsToken]: "<=",
        [ts.SyntaxKind.GreaterThanToken]: ">", [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===", [ts.SyntaxKind.EqualsEqualsToken]: "==",
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==", [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
        [ts.SyntaxKind.AmpersandToken]: "&", [ts.SyntaxKind.BarToken]: "|",
        [ts.SyntaxKind.CaretToken]: "^", [ts.SyntaxKind.LessThanLessThanToken]: "<<",
        [ts.SyntaxKind.GreaterThanGreaterThanToken]: ">>",
        [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: ">>>",
        [ts.SyntaxKind.AsteriskAsteriskToken]: "**",
      };
      const op = opMap[node.operatorToken.kind];
      // sequence-point eval: snapshot a bare-variable lhs if rhs may mutate it.
      const [lhs, rhs] = this.lowerSequenced(ctx, [node.left, node.right]);
      const dst = this.newLocal(ctx, this.refKindOf(node));
      // `a === b` with both operands declared as references (object types,
      // null, undefined; no primitive, any, unknown or type parameter): the
      // operands' locals are marked reference-typed, and the emitter compares
      // the bits (docs/ref_eq_design.md). The declared types, not the
      // narrowed ones: a variable's local serves every site of the variable.
      if ((op === "===" || op === "!==") && this.strictTypeOptimizationsEnabled() &&
          this.declaredReferenceOnly(node.left) && this.declaredReferenceOnly(node.right)) {
        this.markReferenceLocal(ctx, lhs);
        this.markReferenceLocal(ctx, rhs);
      }
      if (op) ctx.body.push({ kind: "BinOp", dst, op, lhs, rhs });
      else this.unsupported(node, `binary operator ${ts.SyntaxKind[node.operatorToken.kind]}`);
      return dst;
    }
    if (ts.isTypeOfExpression(node)) {
      const operand = this.lowerExpr(ctx, node.expression);
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "UnOp", dst, op: "typeof", operand });
      return dst;
    }
    if (ts.isDeleteExpression(node)) {
      // delete obj.prop : remove the property; result is a boolean (true).
      const target = node.expression;
      // A prototype-method store writes BOTH key spaces (StoreField +
      // StoreMethod, the dynamic-dispatch bridge), so delete must clear both —
      // otherwise the METHOD-side dispatch fallback keeps resolving the deleted
      // method (silent DIFF: `p.k` read as undefined but `h.k()` still called).
      // Only names already interned as method names can have a METHOD twin;
      // nameIntern is probed with get() so the lookup never mints new ids.
      const emitDelete = (objExpr: ts.Expression, name: string): number => {
        const obj = this.lowerExpr(ctx, objExpr);
        const dst = this.newLocal(ctx, "reference");
        const inst: any = { kind: "DeleteField", dst, obj, field: this.internField(name) };
        const m = this.nameIntern.get(name);
        if (m !== undefined) inst.method = m;
        ctx.body.push(inst);
        return dst;
      };
      if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) {
        return emitDelete(target.expression, target.name.text);
      }
      if (ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression)) {
        return emitDelete(target.expression, target.argumentExpression.text);
      }
      if (ts.isElementAccessExpression(target)) {
        const [obj, key] = this.lowerSequenced(ctx, [target.expression, target.argumentExpression]);
        const dst = this.newLocal(ctx, "reference");
        this.hasDynamicDelete = true;
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "object.deleteDynamic", args: [obj, key] });
        return dst;
      }
      this.unsupported(node, "delete with a dynamic/computed property (only obj.prop and obj['lit'] supported)");
    }
    if (ts.isYieldExpression(node)) {
      // yield* inner: delegate to an inner (async) generator. Lower to the explicit
      // driving loop using existing primitives (yield + .next() + field reads), so
      // the state-machine builder handles the suspensions automatically.
      if (node.asteriskToken) {
        const innerExpr = node.expression!;
        // A built-in iterable (array / string / Map / Set) has no runtime iterator
        // object for resolveIterator to drive: the runtime fast-paths these by index
        // and registers no [Symbol.iterator] on them (Map/Set would even produce a
        // runtime "value is not a function" if driven). Yield each element directly via
        // an index loop, mirroring for-of's built-in dispatch (lowerArrayIndexForOf;
        // Map/Set materialize to an array first). yield*'s value is the inner iterator's
        // return value, which for these built-ins is undefined. Must run BEFORE
        // resolveIterator (Map/Set are otherwise mis-detected as iterable and crash).
        const rk = this.builtinReceiverKind(innerExpr);
        if (rk === "array" || rk === "string" || rk === "map" || rk === "set") {
          let arr: number;
          if (rk === "map" || rk === "set") {
            const recv = this.lowerExpr(ctx, innerExpr);
            arr = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltin", dst: arr, builtin: rk === "map" ? "map.entries" : "set.values", recv, args: [] });
            const snapshot = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltinStatic", dst: snapshot, builtin: "array.from", args: [arr] });
            arr = snapshot;
            this.emitIndexYieldLoop(ctx, arr, false);
          } else {
            arr = this.lowerExpr(ctx, innerExpr);
            this.emitIndexYieldLoop(ctx, arr, rk === "string");
          }
          const exprU = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Const", dst: exprU, value: { kind: "Undef" } });
          return exprU;
        }
        // yield* drives the inner iterator, forwarding each value to our caller and
        // sent values back in. The driver is shared via resolveIterator so the
        // iterator-kind handling is identical to for-of / for-await.
        const drv = this.resolveIterator(ctx, innerExpr, { forceAsync: !!ctx.isAsync });
        if (!drv) {
          this.unsupported(node, "yield* over a non-iterable (only Generator/AsyncGenerator/iterator-protocol objects supported)");
          return this.newLocal(ctx, "reference");
        }
        const valueField = this.internField("value");
        const doneField = this.internField("done");
        const sent = this.newLocal(ctx, "reference");          // value sent into inner
        const undef0 = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: undef0, value: { kind: "Undef" } });
        ctx.body.push({ kind: "Copy", dst: sent, src: undef0 });
        const rstar = this.newLocal(ctx, "reference");         // {value,done} of inner
        // The delegation ends abruptly when this generator is returned from or thrown
        // into (the resumption runs the finally) or the body of a throw-forwarding
        // step rethrows: then the inner iterator is closed, as for-of closes it.
        const delegationDone = this.newLocal(ctx, "primitive");
        const falseD = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst: falseD, value: { kind: "Bool", value: false } });
        ctx.body.push({ kind: "Copy", dst: delegationDone, src: falseD });
        const delegationBody = this.captureBody(ctx, () => {
        // first step
        { const r = drv.step(sent); ctx.body.push({ kind: "Copy", dst: rstar, src: r }); }
        // loop: while (!r.done) { sent = yield r.value; r = it.next(sent); }
        let condLocal = -1;
        const condBody = this.captureBody(ctx, () => {
          const doneVal = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadField", dst: doneVal, obj: rstar, field: doneField });
          condLocal = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "UnOp", dst: condLocal, op: "!", operand: doneVal });
        });
        const bodyB = this.captureLoopBody(ctx, "while", () => {
          const val = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadField", dst: val, obj: rstar, field: valueField });
          if (!drv.throwStep) {
            // no throw forwarding possible: plain yield + advance.
            this.emitYieldInst(ctx, sent, val);
            const r = drv.step(sent);
            ctx.body.push({ kind: "Copy", dst: rstar, src: r });
            return;
          }
          // throw-aware step: a .throw() into the delegating generator at this
          // yield point must be forwarded to inner.throw(e). We detect the throw
          // by wrapping the yield in try/catch:
          //   try { sent = yield val; threw = false }
          //   catch (e) { thrown = e; threw = true }
          //   r = threw ? inner.throw(thrown) : inner.next(sent)
          const threw = this.newLocal(ctx, "primitive");
          const thrown = this.newLocal(ctx, "reference");
          const falseC = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst: falseC, value: { kind: "Bool", value: false } });
          ctx.body.push({ kind: "Copy", dst: threw, src: falseC });
          const tryBody = this.captureBody(ctx, () => {
            this.emitYieldInst(ctx, sent, val);
          });
          const catchBody = this.captureBody(ctx, () => {
            const trueC = this.newLocal(ctx, "primitive");
            ctx.body.push({ kind: "Const", dst: trueC, value: { kind: "Bool", value: true } });
            ctx.body.push({ kind: "Copy", dst: threw, src: trueC });
          });
          ctx.body.push({ kind: "TryCatch", tryBody, catchVar: thrown, catchBody, finallyBody: [] });
          // r = threw ? inner.throw(thrown) : inner.next(sent)
          const thenBody = this.captureBody(ctx, () => {
            const r = drv.throwStep!(thrown);
            ctx.body.push({ kind: "Copy", dst: rstar, src: r });
          });
          const elseBody = this.captureBody(ctx, () => {
            const r = drv.step(sent);
            ctx.body.push({ kind: "Copy", dst: rstar, src: r });
          });
          ctx.body.push({ kind: "If", cond: threw, thenBody, elseBody });
        });
        ctx.body.push({ kind: "Loop", cond: condLocal, condBody, body: bodyB });
        const trueD = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst: trueD, value: { kind: "Bool", value: true } });
        ctx.body.push({ kind: "Copy", dst: delegationDone, src: trueD });
        });
        if (drv.returnCall) {
          const finallyBody = this.captureBody(ctx, () => {
            const abrupt = this.newLocal(ctx, "primitive");
            ctx.body.push({ kind: "UnOp", dst: abrupt, op: "!", operand: delegationDone });
            const thenBody = this.captureBody(ctx, () => { drv.returnCall!(); });
            ctx.body.push({ kind: "If", cond: abrupt, thenBody, elseBody: [] });
          });
          ctx.body.push({ kind: "TryCatch", tryBody: delegationBody, catchVar: null, catchBody: [], finallyBody });
        } else {
          for (const inst of delegationBody) ctx.body.push(inst);
        }
        // value of the yield* expression = inner's return value (r.value when done)
        const exprVal = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadField", dst: exprVal, obj: rstar, field: valueField });
        return exprVal;
      }
      // yield e: hand e to the .next() caller and suspend; resume value -> dst.
      const operand = node.expression ? this.lowerExpr(ctx, node.expression) : this.newLocal(ctx, "reference");
      if (!node.expression) ctx.body.push({ kind: "Const", dst: operand, value: { kind: "Undef" } });
      const dst = this.newLocal(ctx, this.refKindOf(node));
      this.emitYieldInst(ctx, dst, operand);
      return dst;
    }
    if (ts.isAwaitExpression(node)) {
      // `await` can only suspend inside an async coroutine. ctx.isAsync is true for
      // an async function AND for the synthetic async __module_init that carries a
      // module's top-level await (V8's single-module model: the module body IS an
      // async function driven by the event loop). A bare Await in a synchronous
      // context would silently yield garbage, so loud-reject instead.
      if (!ctx.isAsync) {
        this.unsupported(node, "await outside an async function (in a non-async context that cannot suspend)");
        return this.newLocal(ctx, this.refKindOf(node));
      }
      // await e: evaluate e to a Promise, suspend until it settles, resume value.
      const operand = this.lowerExpr(ctx, node.expression);
      const dst = this.newLocal(ctx, this.refKindOf(node));
      ctx.body.push({ kind: "Await", dst, operand });
      return dst;
    }
    if (ts.isVoidExpression(node)) {
      // void e: evaluate e for side effects, result is undefined (a tsv value)
      this.lowerExpr(ctx, node.expression);
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
      return dst;
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      // (Constant `-0` — the literal and any constant arithmetic evaluating to -0 —
      // is folded to a NegZero const at the top of lowerExpr via constNumValue.)
      const operand = this.lowerExpr(ctx, node.operand);
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        // ++/-- always operate numerically: oldValue = ToNumber(operand),
        // newValue = oldValue +/- 1. The postfix value is the *number* oldValue
        // (so `let x:any="5"; x++` yields x===6 and `const y=x++` yields y===5,
        // both numbers). Without coercion `++` lowered to a string-aware `+`
        // BinOp (ts_add), miscompiling string/`any` operands.
        const isPostfix = ts.isPostfixUnaryExpression(node);
        // Keep the unboxed fast path when the operand is already numeric;
        // otherwise ToNumber-coerce once (mirrors unary `+`).
        let isNum = false;
        try { isNum = (this.checker.getTypeAtLocation(node.operand).flags & ts.TypeFlags.NumberLike) !== 0; } catch { /* not number */ }
        let base = operand;
        if (!isNum) {
          const coerced = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "CallBuiltinStatic", dst: coerced, builtin: "number.coerce", args: [operand] });
          base = coerced;
        }
        // snapshot the pre-update (already-numeric) value (postfix returns this)
        const old = this.newLocal(ctx, "primitive");
        if (isPostfix) ctx.body.push({ kind: "Copy", dst: old, src: base });
        const one = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst: one, value: { kind: "Num", value: 1 } });
        const res = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "BinOp", dst: res, op: op === ts.SyntaxKind.PlusPlusToken ? "+" : "-", lhs: base, rhs: one });
        this.lowerAssignTarget(ctx, node.operand, res);
        return isPostfix ? old : res;
      }
      if (op === ts.SyntaxKind.MinusToken) {
        const dst = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "UnOp", dst, op: "-", operand });
        return dst;
      }
      else if (op === ts.SyntaxKind.ExclamationToken) {
        // `!x` is a boolean; classify via the node type so it boxes as a JS
        // boolean (printed true/false) unless later proven truthy-only & unboxed.
        const dst = this.newLocal(ctx, this.refKindOf(node));
        ctx.body.push({ kind: "UnOp", dst, op: "!", operand });
        return dst;
      }
      else if (op === ts.SyntaxKind.PlusToken) {
        // unary `+x` = ToNumber(x). If x is already numeric it's identity (keep
        // the fast unboxed copy); otherwise coerce (string/any -> number,
        // "" -> 0, "abc" -> NaN, object -> ToPrimitive).
        const dst = this.newLocal(ctx, "primitive");
        let isNum = false;
        try { isNum = (this.checker.getTypeAtLocation(node.operand).flags & ts.TypeFlags.NumberLike) !== 0; } catch { /* not number */ }
        if (isNum) {
          ctx.body.push({ kind: "Copy", dst, src: operand });  // already a number: identity
        } else {
          ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "number.coerce", args: [operand] });
        }
        return dst;
      }
      else if (op === ts.SyntaxKind.TildeToken) {
        // `~x`: bitwise NOT — operand goes through ToInt32, result is a 32-bit int.
        const dst = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "UnOp", dst, op: "~", operand });
        return dst;
      }
      else { this.unsupported(node, `unary operator ${ts.SyntaxKind[op]}`); return this.newLocal(ctx, "unknown"); }
    }
    if (ts.isConditionalExpression(node)) {
      const decided = this.constCondValue(node.condition);
      if (decided !== undefined) return this.lowerExpr(ctx, decided ? node.whenTrue : node.whenFalse);
      // cond ? a : b  ->  res; if (cond) res=a else res=b
      const cond = this.lowerCond(ctx, node.condition);
      const res = this.newLocal(ctx, this.refKindOf(node));
      const tb = this.captureBody(ctx, () => {
        const a = this.lowerExpr(ctx, node.whenTrue);
        ctx.body.push({ kind: "Copy", dst: res, src: a });
      });
      const eb = this.captureBody(ctx, () => {
        const b = this.lowerExpr(ctx, node.whenFalse);
        ctx.body.push({ kind: "Copy", dst: res, src: b });
      });
      ctx.body.push({ kind: "If", cond, thenBody: tb, elseBody: eb });
      return res;
    }
    if (ts.isTemplateExpression(node)) {
      // AOT template plan: fold side-effect-free primitive substitutions into
      // adjacent static text, evaluate every remaining substitution followed
      // immediately by ToString, then allocate/copy the complete result once via
      // string.concatMany. Keeping string.coerce beside lowerExpr preserves the
      // spec-observable order between one substitution's ToString and evaluation
      // of the next substitution.
      const parts: number[] = [];
      let pendingStatic = node.head.text;
      const flushStatic = () => {
        if (pendingStatic.length === 0) return;
        const lit = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: lit, value: { kind: "Str", value: pendingStatic } });
        parts.push(lit);
        pendingStatic = "";
      };
      for (const span of node.templateSpans) {
        const folded = this.constTemplateString(span.expression);
        if (folded !== undefined) {
          pendingStatic += folded;
          pendingStatic += span.literal.text;
          continue;
        }
        flushStatic();
        const raw = this.lowerExpr(ctx, span.expression);
        const e = this.newLocal(ctx, "reference");
        // a template's ToString: a Symbol substitution is a TypeError (String(sym) is its description)
        ctx.body.push({ kind: "CallBuiltinStatic", dst: e, builtin: "string.coerceTemplate", args: [raw] });
        parts.push(e);
        pendingStatic = span.literal.text;
      }
      flushStatic();
      if (parts.length === 1) return parts[0];
      // A TemplateExpression always contains at least one substitution. The only
      // way to have no parts is for all substitutions and static chunks to fold
      // to the empty string.
      if (parts.length === 0) {
        const empty = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: empty, value: { kind: "Str", value: "" } });
        return empty;
      }
      const out = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "CallBuiltinStatic", dst: out, builtin: "string.concatMany", args: parts });
      return out;
    }
    if (ts.isNumericLiteral(node)) {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Num", value: this.numWire(Number(node.text)) } });
      return dst;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Str", value: node.text } });
      return dst;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Bool", value: node.kind === ts.SyntaxKind.TrueKeyword } });
      return dst;
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Null" } });
      return dst;
    }
    if (node.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(node) && node.text === "undefined")) {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
      return dst;
    }
    this.unsupported(node, `expression ${ts.SyntaxKind[node.kind]}`);
    return this.newLocal(ctx, this.refKindOf(node));
  }

  /** Record an unsupported-syntax error. The exporter collects these and fails
   *  loudly rather than silently emitting incomplete IR. */
  unsupported(node: ts.Node, what: string): void {
    const sf = node.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
    this.unsupportedList.push(`${what} at ${sf.fileName}:${line + 1}:${character + 1}`);
  }

  // Module linkage (import/export) handling. tsaot is ESM-only and v1 is
  // single-file: every linkage construct is loud-rejected, EXCEPT type-only
  // forms which are erased (they have no runtime meaning). Returns true if the
  // statement was a linkage construct (handled here, whether erased or
  // rejected); false if it is not a linkage statement at all.
  //
  // This replaces the previous behavior where imports/most exports were
  // SILENTLY skipped — a silent miscompile (e.g. `import { readFileSync }`
  // made `readFileSync` resolve to undefined). See module_linkage.md §4.1.
  tryHandleLinkage(stmt: ts.Statement): boolean {
    // import ... from "..."
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      const target = this.resolveModuleSf(stmt.moduleSpecifier);
      // `import "./b"` (side-effect): b's top-level runs in execution order, so a
      // bundled target needs nothing here. A non-bundled (node_modules/CJS) target
      // is deferred → loud-reject.
      if (!clause) {
        if (!target) this.unsupported(stmt, "side-effect import of a non-bundled module (CommonJS/node_modules interop not supported yet; ESM-only v1)");
        return true;
      }
      if (clause.isTypeOnly) return true;
      const named = clause.namedBindings;
      const hasDefault = !!clause.name;
      // fully type-only named import → erase.
      if (!hasDefault && named && ts.isNamedImports(named) && named.elements.every((e) => e.isTypeOnly)) return true;
      if (!target) {
        this.unsupported(stmt, "import from a non-bundled module (CommonJS/node_modules interop not supported yet; ESM-only v1)");
        return true;
      }
      // `import * as ns` builds a runtime namespace object; handled in lowerStmt
      // (kept in moduleStmts). Named/default bindings resolve via symbol linking
      // (alias unwrap) with no runtime code — erase here.
      return true;
    }
    // export { ... } / export { ... } from "..." / export * from "..."
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) return true;
      const named = stmt.exportClause;
      if (named && ts.isNamedExports(named) && named.elements.every((e) => e.isTypeOnly)) return true;
      // `export * as ns from "m"`: re-exports the target's bindings as a single
      // namespace object bound to `ns`. Unlike `import * as ns` (materialized by
      // lowerNamespaceImport), there is no runtime object built here, so a consumer's
      // `import { ns }` would resolve to an unmaterialized symbol → undefined at
      // runtime (silent miscompile). Loud-reject until the namespace object is
      // materialized at this export site.
      if (named && ts.isNamespaceExport(named)) {
        if (!ts.isIdentifier(named.name)) this.unsupported(stmt, "`export * as \"string name\"` (a string export name) is not supported");
        return true;   // the identifier form is lowered by materializeNamespace (lowerStatement)
      }
      // `export {x}` / `export {x} from "m"` / `export * from "m"`: re-exports are
      // resolved by the alias chain at the importing site — no runtime code. A
      // `from` target must be a bundled module.
      if (stmt.moduleSpecifier && !this.resolveModuleSf(stmt.moduleSpecifier)) {
        this.unsupported(stmt, "re-export from a non-bundled module (CommonJS/node_modules interop not supported yet; ESM-only v1)");
      }
      return true;
    }
    // export default ...
    if (ts.isExportAssignment(stmt)) {
      if (stmt.isExportEquals) {
        this.unsupported(stmt, "CommonJS `export =` is not supported (tsaot is ESM-only)");
        return true;
      }
      // `export default <name>` aliases the binding (resolved on import — erase).
      // `export default function|class` are declarations (handled normally); any other
      // `export default <expression>` is lowered by lowerStatement (bindDefaultExport).
      return true;
    }
    // import X = require("...") / import X = NS  (TS/CJS style)
    if (ts.isImportEqualsDeclaration(stmt)) {
      this.unsupported(stmt, "`import =` (CommonJS/namespace import-equals) is not supported (tsaot is ESM-only)");
      return true;
    }
    return false;
  }

  private namespaceObject(ctx: FnCtx, name: ts.Identifier): number {
    const sym = this.symbolOf(name);
    const cid = sym && this.classSymToId.get(sym);
    const container = cid !== undefined ? this.staticContainerClassOf(cid) : undefined;
    const global = container !== undefined ? this.classStaticGlobal.get(container) : undefined;
    if (global !== undefined) {
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadGlobal", dst, gref: global });
      return dst;
    }
    return this.lowerIdentifier(ctx, name);
  }

  lowerIdentifier(ctx: FnCtx, node: ts.Identifier): number {
    let sym = this.symbolOf(node);
    // a callback parameter bound by specialization names the function itself:
    // box it with the cells this clone holds (the binding rule guarantees them)
    if (sym && this.callbackSubst?.has(sym)) {
      const target = this.callbackSubst.get(sym)!;
      const v = this.directFunctionValue(ctx, this.funcSymbols.get(target)!);
      if (v !== undefined) return v;
      this.unsupported(node, `specialized callback '${node.text}' used as a value where its captures are unavailable`);
      sym = target;
    }
    if (node.text === "arguments" && !sym?.declarations?.length) {
      // the arguments object as a value: the actual arguments as an array (`apply(this, arguments)`,
      // `arguments[i]`, `Array.from(arguments)`; the function keeps its generic entry for the count)
      const dst = this.newLocal(ctx, "reference", "arguments");
      if (ctx.argumentsOffset === undefined || ctx.isAsync || ctx.isGenerator) {
        this.unsupported(node, "the arguments object in an arrow function or a coroutine");
        ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
        return dst;
      }
      ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: `arguments.array:${ctx.argumentsOffset}`, args: [] });
      return dst;
    }
    const namespace = sym && this.namespaceBindings.get(sym);
    if (namespace) {
      const obj = this.namespaceObject(ctx, namespace.namespace);
      const dst = this.newLocal(ctx, this.refKindOf(node), node.text);
      ctx.body.push({ kind: "LoadField", dst, obj, field: this.internField(namespace.name) });
      return dst;
    }
    // Global value keywords that have no user symbol.
    if (node.text === "undefined" && this.isAmbientGlobalSymbol(sym)) {
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
      return dst;
    }
    if (node.text === "NaN" && this.isAmbientGlobalSymbol(sym)) {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: { kind: "NaN" } });
      return dst;
    }
    if (node.text === "Infinity" && this.isAmbientGlobalSymbol(sym)) {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: { kind: "PosInf" } });
      return dst;
    }
    if (node.text === "globalThis" && this.isAmbientGlobalSymbol(sym)) {
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadBuiltinFn", dst, builtin: "globalThis" });
      return dst;
    }
    // A bare builtin global referenced AS A VALUE (`Array`, `Promise`, `parseInt`,
    // `String`, `Math`, `console`, ...). Calls (`parseInt(x)`) still use the fast
    // builtin call path, but value reads go through the runtime global object so
    // identity matches `globalThis.X` and later script-mode `var X = ...` can
    // overwrite the same property. User bindings that shadow the name have a
    // source declaration, so they fall through to ordinary local/global lowering.
    {
      const gname = this.globalObjectValueName(node.text);
      if (gname !== undefined && this.isAmbientGlobalSymbol(sym)) {
        return this.loadGlobalObjectProperty(ctx, gname);
      }
    }
    if (this.isScriptGlobalVarSymbol(sym, node.text)) {
      return this.loadGlobalObjectProperty(ctx, node.text);
    }
    if (node.text === "RegExp" && this.isAmbientGlobalSymbol(sym)) {
      this.unsupported(node, "RegExp as a value (not implemented)");
      const dst = this.newLocal(ctx, "reference", node.text);
      ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
      return dst;
    }
    if (this.isLexicalTdzUse(node, sym) || this.isCyclicCrossModuleTdzUse(node, sym)) {
      this.unsupported(node, `TDZ read of '${node.text}' before initialization`);
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
      return dst;
    }
    {
      // A module-scope `const` holding a literal (`const CH_QUOTE = 34`): the
      // constant itself, not a read of the module's cell (a TDZ read was
      // rejected above).
      const lit = this.moduleConstLiteral(sym);
      if (lit !== undefined) {
        const dst = this.newLocal(ctx, lit.kind === "Str" ? "reference" : "primitive", node.text);
        ctx.body.push({ kind: "Const", dst, value: lit });
        return dst;
      }
    }
    if (sym && this.lazyFnValueSyms.has(sym)) {
      const lazy = this.lazyFunctionValue(ctx, sym, node);
      if (lazy !== undefined) return lazy;
    }
    if (sym && this.hasCaptured(ctx, sym)) {
      const dst = this.newLocal(ctx, this.refKindOf(node));
      this.loadCaptured(ctx, sym, dst);
      return dst;
    }
    if (sym && ctx.localOfSymbol.has(sym)) {
      return ctx.localOfSymbol.get(sym)!;
    }
    // Step E: a module-scope binding captured by a method is published in a
    // GLOBALS[] slot (the method can't receive the cell as a param). Load the
    // cell from the global, then read its .VALUE. Only applies when the binding
    // isn't already available as a threaded cell (handled above).
    if (sym && this.moduleCellGlobal.has(sym)) {
      const ref = this.moduleCapturedRef(ctx, sym)!;
      const dst = this.newLocal(ctx, this.refKindOf(node));
      ctx.body.push({ kind: "LoadField", dst, obj: ref.obj, field: ref.field, ...(ref.cls ? { cls: ref.cls } : {}) });
      return dst;
    }
    // Fallback for class values that do not have a stored lexical binding in this
    // lowering context (for example a class reference inside a synthetic static
    // helper that did not capture the binding). Normal class declarations are
    // initialized in lowerStmt and read through the branches above, preserving
    // constructor identity (`C === C`).
    {
      const cvClassId = sym ? this.classSymToId.get(sym) : undefined;
      if (cvClassId !== undefined) {
        const v = this.emitClassValue(ctx, cvClassId, node.text, node);
        if (v !== undefined) return v.local;
      }
    }
    if (sym && this.funcSymbols.has(sym)) {
      const gref = this.functionValueGlobal.get(sym);
      if (gref !== undefined) {
        const dst = this.newLocal(ctx, "reference", node.text);
        ctx.body.push({ kind: "LoadGlobal", dst, gref });
        return dst;
      }
      if (this.nestedFuncSymbols.has(sym)) {
        // A nested declaration's value outside its hoisted binding: box it with
        // the captures this context holds (identity differs from the hoisted
        // closure, which only matters for a value the scan did not see).
        const v = this.directFunctionValue(ctx, this.funcSymbols.get(sym)!);
        if (v !== undefined) return v;
        this.unsupported(node, `nested function '${node.text}' used as a value where its captures are unavailable`);
      }
      // A top-level function used as a VALUE (e.g. `f` in `f.call(...)`, or passed
      // as a callback) must be boxed into a ts_func. Emit a capture-less closure;
      // its codegen sets o.proto = g_function_proto and the takes_this flag, so
      // Function.prototype.call/apply/bind resolve on it.
      const dst = this.newLocal(ctx, "reference", node.text);
      const site = this.site++;
      this.labels[site] = `fnref ${node.text}@${ctx.name}`;
      this.recordSite(site, "closure", "once", true, node);
      ctx.body.push({ kind: "AllocClosure", dst, func: this.funcSymbols.get(sym)!, captures: [], site });
      return dst;
    }
    // Step B (scope_resolution.md §12): module-scoped bindings no longer go
    // through LoadGlobal/StoreGlobal. Until Step C wires them through cells,
    // they fall through to ensureLocal below (a function-local). This is still
    // incorrect for cross-function module-binding reads (the same gap as before
    // session 5), and is fixed properly by Step C. The LoadGlobal/StoreGlobal
    // opcodes + GLOBALS[] infra remain in the IR/runtime for the
    // GlobalEnvironment record (globalThis, host globals) — they just have no
    // producer for module bindings.
    // Any other value the environment provides (the default library's `Intl`,
    // `WeakRef`, ...; a host's `declare var` or `declare global`) is a property
    // of the global object: read it there (undefined when nothing defines it)
    // rather than from a local nothing assigns.
    {
      const def = this.defineValueOf(node, sym);
      if (def !== undefined) return this.defineConst(ctx, node, def);
    }
    if (sym && (this.isDefaultLibSymbol(sym) || this.isAmbientValueSymbol(sym))) return this.loadEnvironmentValue(ctx, node);
    if (sym) return this.ensureLocal(ctx, sym, this.refKindOf(node), node.text);
    return this.newLocal(ctx, this.refKindOf(node), node.text);
  }
  /** A value the environment provides: a variable, function or class whose
   *  every declaration is ambient (a .d.ts file, `declare`, `declare global`). */
  isAmbientValueSymbol(sym: ts.Symbol | undefined): boolean {
    if (!sym || (sym.flags & ts.SymbolFlags.Alias)) return false;
    if (!(sym.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.ValueModule))) return false;
    const decls = sym.declarations;
    return !!decls && decls.length > 0 &&
      decls.every((d) => d.getSourceFile().isDeclarationFile || (ts.getCombinedNodeFlags(d) & AMBIENT_NODE_FLAG) !== 0);
  }
  /** A symbol declared only in the default library files (lib.*.d.ts). */
  isDefaultLibSymbol(sym: ts.Symbol): boolean {
    const decls = sym.declarations;
    return !!decls && decls.length > 0 && decls.every((d) => this.program.isSourceFileDefaultLibrary(d.getSourceFile()));
  }

  /** `class D extends <value> {}` (no members): a derived constructor over the runtime value, made by
   *  the runtime (`ts_class_extend_dyn`): `new D(...)` constructs the base and gives the instance D's
   *  prototype (whose prototype is the base's), D's statics chain to the base, D's name is the class's. */
  private lowerDynamicDerivedClass(ctx: FnCtx, base: ts.Expression, name: string): number {
    const parent = this.lowerExpr(ctx, base);
    const nameL = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: nameL, value: { kind: "Str", value: name } });
    const dst = this.newLocal(ctx, "reference", name || undefined);
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "class.extend_dyn", args: [parent, nameL] });
    return dst;
  }
  /** Lower a class EXPRESSION (`const C = class { ... }`, named or anonymous) to a
   *  runtime class value — the same machinery a class declaration uses when read as
   *  a value. Dynamic-base (mixin) class expressions stay loud-rejected (their
   *  layout isn't statically known). Mirrors the ClassDeclaration value emission in
   *  lowerStmt (emitClassValue + static-init + container linkage). */
  lowerClassExpressionValue(ctx: FnCtx, node: ts.ClassExpression, hint?: string): number {
    const cid = this.classIdByNode.get(node);
    if (cid === undefined) {
      const base = dynamicBaseEmptyClass(node, this.checker);
      if (base) return this.lowerDynamicDerivedClass(ctx, base, node.name?.text ?? hint ?? "");
      this.unsupported(node, "class expression (no resolved class id)");
      return this.newLocal(ctx, "reference", hint);
    }
    const info = this.classInfos[cid];
    if (info && info.reasons.some((r) => r.startsWith("extends-non-identifier"))) {
      this.unsupported(node, "class expression with a dynamic (mixin) base class");
      return this.newLocal(ctx, "reference", hint);
    }
    const cv = this.emitClassValue(ctx, cid, node.name?.text ?? hint ?? "class", node, false);
    if (cv === undefined) {
      this.unsupported(node, "class expression value (unconstructible)");
      return this.newLocal(ctx, "reference", hint);
    }
    // Run __static_init (if any) at the expression's evaluation position, then link
    // the static container — same order as the declaration form.
    if (this.classStaticGlobal.has(cid)) {
      const initFnId = this.staticInits.find((s) => s.classId === cid)?.fnId;
      if (initFnId !== undefined) {
        ctx.body.push({ kind: "Call", dst: this.newLocal(ctx, "reference"),
          callee: { kind: "Direct", func: initFnId }, args: this.staticInitArgs(ctx, cid, cv) });
      }
    }
    if (cv.classValue) this.linkClassValueStaticContainer(ctx, cv.local, cid);
    return cv.local;
  }

  emitClassValue(ctx: FnCtx, classId: number, hint: string, node: ts.Node, linkStatic = true): ClassValueEmit | undefined {
    const cvCtor = this.methodFunc.get(`${classId}:ctor`);
    if (cvCtor !== undefined) {
      const captures = this.classValueCaptures(ctx, cvCtor);
      if (captures !== null) {
        if (this.classInfos[classId]) this.classInfos[classId].instantiated = true;
        const dst = this.newLocal(ctx, "reference", hint);
        ctx.body.push({ kind: "AllocClassValue", dst, classId, ctor: cvCtor, captures, ...(this.sharedClassProto(classId) ? { once: true } : {}) });
        this.defineClassPrototypeConstructor(ctx, classId, dst);
        this.linkClassValuePrototypeParent(ctx, dst, classId);
        if (linkStatic) this.linkClassValueStaticContainer(ctx, dst, classId);
        return { local: dst, classValue: true };
      }
    }
    const synthFn = this.synthClassValueCtor(classId);
    if (synthFn !== undefined) {
      const captures = this.synthClassValueCaptures(ctx, classId);
      if (captures !== null) {
        if (this.classInfos[classId]) this.classInfos[classId].instantiated = true;
        const dst = this.newLocal(ctx, "reference", hint);
        ctx.body.push({ kind: "AllocClassValue", dst, classId, ctor: synthFn, captures, ...(this.sharedClassProto(classId) ? { once: true } : {}) });
        this.defineClassPrototypeConstructor(ctx, classId, dst);
        this.linkClassValuePrototypeParent(ctx, dst, classId);
        if (linkStatic) this.linkClassValueStaticContainer(ctx, dst, classId);
        return { local: dst, classValue: true };
      }
    }
    const ncc = this.staticContainerClassOf(classId);
    if (ncc !== undefined) {
      const cont = this.newLocal(ctx, "reference", hint);
      ctx.body.push({ kind: "LoadGlobal", dst: cont, gref: this.classStaticGlobal.get(ncc)! });
      return { local: cont, classValue: false };
    }
    this.unsupported(node, "class value requires a constructor value but the class captures an enclosing function local that cannot be threaded here");
    const u = this.newLocal(ctx, "reference", hint);
    ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
    return { local: u, classValue: false };
  }

  linkClassValueStaticContainer(ctx: FnCtx, dst: number, classId: number) {
    const ccc = this.staticContainerClassOf(classId);
    if (ccc !== undefined) {
      const cont = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadGlobal", dst: cont, gref: this.classStaticGlobal.get(ccc)! });
      ctx.body.push({ kind: "SetProto", obj: dst, proto: cont });
    }
  }

  defineClassPrototypeConstructor(ctx: FnCtx, classId: number, classValue: number) {
    void classId;
    const proto = this.loadClassValuePrototype(ctx, classValue);
    const key = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: key, value: { kind: "Str", value: "constructor" } });
    ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
      builtin: "object.defineData:0:1:1", args: [proto, key, classValue] });
  }

  /** The static builtin a call through a const alias of `NS.member` lowers to (constBuiltinAliases), or
   *  undefined when the member or this argument count has none: the call then goes through the value. */
  private builtinAliasCallName(sym: ts.Symbol, argc: number): string | undefined {
    const a = this.constBuiltinAliases.get(sym);
    if (!a) return undefined;
    const sname = this.namespaceBuiltin(a.ns, a.member, argc);
    return sname === undefined || sname === "__UNSUPPORTED__" ? undefined : sname;
  }
  /** A class binding read where its declaration may not have run yet (from
   *  another function: the same function's earlier reads are rejected at
   *  compile time) holds undefined until then: reading it is a ReferenceError
   *  in JS, which the shared-prototype `new` and `instanceof` (they need no
   *  value from it) must still raise. */
  checkClassBindingInitialized(ctx: FnCtx, ref: ts.Expression, value: number): void {
    if (!ts.isIdentifier(ref)) return;
    const sym = this.unwrapImportAlias(this.checker.getSymbolAtLocation(ref)) ?? this.checker.getSymbolAtLocation(ref);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (decl && decl.getSourceFile() === ref.getSourceFile() && this.enclosingFunction(decl) === this.enclosingFunction(ref) &&
        decl.getStart() < ref.getStart()) return;
    ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: `binding.check:${ref.text}`, args: [value] });
  }
  /** A class whose declaration runs once: its class value takes the
   *  registered prototype (CLASS_PROTO) itself instead of a copy
   *  (`ts_make_class_value_once`), so a static `new` sets it without reading
   *  the class value's `prototype`, and `instanceof` and the receiver class
   *  guards compare with it. TSAOT_SHARED_CLASS_PROTO=0 keeps the copies
   *  (the frozen emitter's IR). */
  sharedClassProto(classId: number): boolean {
    return process.env.TSAOT_SHARED_CLASS_PROTO !== "0" && this.classEvaluatedOnce(classId);
  }
  /** A class whose declaration runs once (not inside a function, a loop or
   *  another class). */
  classEvaluatedOnce(classId: number): boolean {
    const decl = this.classNodeOfId.get(classId);
    if (!decl) return false;
    for (let n: ts.Node | undefined = decl.parent; n !== undefined; n = n.parent) {
      if (ts.isSourceFile(n)) return true;
      if (ts.isFunctionLike(n) || ts.isIterationStatement(n, false) || ts.isClassLike(n)) return false;
    }
    return false;
  }
  loadClassValuePrototype(ctx: FnCtx, classValue: number): number {
    const proto = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "LoadField", dst: proto, obj: classValue, field: this.internField("prototype") });
    return proto;
  }

  classSymbolOfId(classId: number): ts.Symbol | undefined {
    for (const [sym, id] of this.classSymToId.entries()) {
      if (id === classId) return sym;
    }
    return undefined;
  }

  loadBoundClassValue(ctx: FnCtx, sym: ts.Symbol, hint?: string): number | undefined {
    if (this.hasCaptured(ctx, sym)) {
      const dst = this.newLocal(ctx, "reference", hint);
      this.loadCaptured(ctx, sym, dst);
      return dst;
    }
    if (ctx.localOfSymbol.has(sym)) return ctx.localOfSymbol.get(sym)!;
    if (this.moduleCellGlobal.has(sym)) {
      const ref = this.moduleCapturedRef(ctx, sym)!;
      const dst = this.newLocal(ctx, "reference", hint);
      ctx.body.push({ kind: "LoadField", dst, obj: ref.obj, field: ref.field, ...(ref.cls ? { cls: ref.cls } : {}) });
      return dst;
    }
    return undefined;
  }

  linkClassValuePrototypeParent(ctx: FnCtx, classValue: number, classId: number) {
    const parentId = this.parentIdOf(classId);
    if (parentId === undefined) return;
    const psym = this.classSymbolOfId(parentId);
    if (!psym) return;
    const parentValue = this.loadBoundClassValue(ctx, psym, this.classInfos[parentId]?.name);
    if (parentValue === undefined) return;
    const childProto = this.loadClassValuePrototype(ctx, classValue);
    const parentProto = this.loadClassValuePrototype(ctx, parentValue);
    ctx.body.push({ kind: "SetProto", obj: childProto, proto: parentProto });
  }

  /** If `e` is a class identifier (e.g. `Mutated`), return its class id. */
  /** Monomorphize a generic function call. Returns the fnId of a specialized
   *  clone (T -> concrete) when the callee is generic with type parameters whose
   *  concrete arguments classify to scalars; otherwise undefined (use the
   *  original, erased function). Specializations are cached per (fn, tag). */
  /** Full generic class cloning. Given a checker type like `Box<number>`, return
   *  a dedicated specialized class id (`Box$number`) whose fields/methods are
   *  lowered with the type parameters substituted to concrete types. Distinct
   *  type-argument tuples become distinct classes (Box$number vs Box$string).
   *  Returns the original class id when the class is non-generic, and undefined
   *  if specialization isn't applicable (caller falls back to the original). */
  maxSpecDepth = 8; // recursion guard for nested generics (Box<Box<...>>)
  maxClassSpecs = 256; // instantiation-count cap (avoid code explosion)
  specializedClassId(t: ts.Type, node: ts.Node, depth = 0): number | undefined {
    if (depth > this.maxSpecDepth) return undefined;
    const sym = t.getSymbol();
    if (!sym) return undefined;
    const origId = this.classSymToId.get(sym);
    if (origId === undefined) return undefined;
    const decl = this.classNodeOfId.get(origId);
    if (!decl) return undefined;
    const tparams = decl.typeParameters;
    if (!tparams || tparams.length === 0) return origId; // non-generic: use original
    if (!this.strictTypeOptimizationsEnabled()) return origId;
    if (!this.classTypeOptimizationSafe(decl)) return origId;
    if (ts.isNewExpression(node) && !this.callArgumentsSafe(node.arguments)) return origId;

    // Resolve concrete type arguments for this instantiation.
    const targs = (this.checker.getTypeArguments
      ? this.checker.getTypeArguments(t as ts.TypeReference)
      : ((t as ts.TypeReference).typeArguments || [])) as ts.Type[];
    if (!targs || targs.length < tparams.length) return undefined;

    const subst = new Map<string, TypeSpec>();
    const tagParts: string[] = [];
    for (let i = 0; i < tparams.length; i++) {
      const tpName = tparams[i].name.text;
      const at = targs[i];
      // nested generic class as a type argument: specialize it too (for naming),
      // but its RefKind is always a reference (heap object).
      const rk = this.classify(at);
      const spec = this.typeSpecForType(at) ?? { kind: "erased", key: this.checker.typeToString(at).replace(/[^A-Za-z0-9]/g, "_"), refKind: rk } as TypeSpec;
      subst.set(tpName, spec);
      tagParts.push(this.checker.typeToString(at).replace(/[^A-Za-z0-9]/g, "_"));
    }
    const tag = tagParts.join("$");
    const key = `${origId}|${tag}`;
    const cached = this.genClassSpecializations.get(key);
    if (cached !== undefined) return cached;
    if (this.genClassSpecializations.size >= this.maxClassSpecs) return undefined; // cap

    // Allocate a new class id (append to classInfos) and clone the definition.
    const newId = this.classInfos.length;
    this.genClassSpecializations.set(key, newId);
    const orig = this.classInfos[origId];
    const specInfo: ClassInfo = {
      id: newId,
      name: `${orig.name}$${tag}`,
      parentName: orig.parentName, // parent specialization is future work
      parentSym: orig.parentSym,   // same parent symbol; parentId updated if the parent specializes
      parentId: orig.parentId,
      ownMethods: orig.ownMethods.map((m) => ({ ...m })),
      ownFields: [...orig.ownFields],
      instantiated: true,
      stable: orig.stable,
      reasons: [...orig.reasons],
    };
    this.classInfos.push(specInfo);
    this.classNodeOfId.set(newId, decl);

    // Clone each method/ctor as a fresh IR function lowered under the subst.
    if (this.specBase < 0) this.specBase = this.fnId.size;
    const savedSubst = this.typeSubst;
    this.typeSubst = subst;
    try {
      for (const m of decl.members) {
        const sname = this.wellKnownMethodName(m) ?? memberKeyName((m as any).name as ts.PropertyName | undefined);
        if (ts.isMethodDeclaration(m) && m.body && sname !== undefined) {
          const fid = this.allocSpecFn();
          this.methodFunc.set(`${newId}:method:${sname}`, fid);
          this.lowerFunctionLike(m as unknown as FnLike, fid, false, true, newId);
        } else if (ts.isGetAccessorDeclaration(m) && m.body && sname !== undefined) {
          const fid = this.allocSpecFn();
          this.methodFunc.set(`${newId}:getter:${sname}`, fid);
          this.lowerFunctionLike(m as unknown as FnLike, fid, false, true, newId);
        } else if (ts.isSetAccessorDeclaration(m) && m.body && sname !== undefined) {
          const fid = this.allocSpecFn();
          this.methodFunc.set(`${newId}:setter:${sname}`, fid);
          this.lowerFunctionLike(m as unknown as FnLike, fid, false, true, newId);
        } else if (ts.isConstructorDeclaration(m) && m.body) {
          const fid = this.allocSpecFn();
          this.methodFunc.set(`${newId}:ctor`, fid);
          this.lowerFunctionLike(m as unknown as FnLike, fid, false, true, newId);
        }
      }
      // record specialized field types (concrete scalar -> "number")
      let fm = this.instFieldTypes.get(newId);
      if (!fm) { fm = new Map(); this.instFieldTypes.set(newId, fm); }
      for (const fname of specInfo.ownFields) {
        const prop = this.checker.getPropertyOfType(t, fname);
        let ftag = "tsv";
        if (prop) {
          const ft = this.checker.getTypeOfSymbolAtLocation(prop, node);
          ftag = this.classify(ft) === "primitive" ? "number" : "tsv";
        }
        if (!fm.has(fname)) fm.set(fname, new Set());
        fm.get(fname)!.add(ftag);
      }
    } finally {
      this.typeSubst = savedSubst;
    }
    return newId;
  }

  /** Allocate a dense, contiguous id for a specialized (cloned) function. */
  allocSpecFn(): number {
    if (this.specBase < 0) this.specBase = this.fnId.size;
    return this.specBase + this.specFnCount++;
  }
  specFnCount = 0;

  /** Generic inheritance: if `classId` extends a generic instantiation
   *  (`class Sub extends Base<number>`), specialize the parent (`Base$number`)
   *  and rewrite this class's parentName to point at it, so inherited fields
   *  carry concrete (`field_types`) types and methods resolve to the cloned base.
   *  Idempotent; safe to call from each `new`/dispatch site. */
  resolveSpecializedParent(classId: number) {
    const info = this.classInfos[classId];
    if (!info) return;
    const decl = this.classNodeOfId.get(classId);
    if (!decl) return;
    const ext = decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    if (!ext || ext.types.length !== 1) return;
    const baseTypeNode = ext.types[0];
    if (!baseTypeNode.typeArguments || baseTypeNode.typeArguments.length === 0) return; // non-generic base
    if (info.parentName && info.parentName.includes("$") &&
        this.classInfos.some((c) => c.name === info.parentName)) return; // already specialized
    try {
      const baseType = this.checker.getTypeAtLocation(baseTypeNode);
      const baseSym = baseType.getSymbol();
      const origParent = baseSym ? this.classSymToId.get(baseSym) : undefined;
      const specParent = this.specializedClassId(baseType, baseTypeNode);
      if (specParent !== undefined && specParent !== origParent) {
        info.parentName = this.classInfos[specParent].name;
        info.parentId = specParent; // retarget the resolved parent to the specialization
      }
    } catch { /* keep erased parent */ }
  }

  directTypeParameterName(typeNode: ts.TypeNode | undefined, names: Set<string>): string | undefined {
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return undefined;
    if (!ts.isIdentifier(typeNode.typeName)) return undefined;
    if (typeNode.typeArguments && typeNode.typeArguments.length > 0) return undefined;
    const name = typeNode.typeName.text;
    return names.has(name) ? name : undefined;
  }

  typeReferenceName(typeName: ts.EntityName): string | undefined {
    return ts.isIdentifier(typeName) ? typeName.text : undefined;
  }

  tupleElementTypeParameterName(typeNode: ts.TupleTypeNode, names: Set<string>): string | undefined {
    let found: string | undefined;
    for (const elem of typeNode.elements) {
      if (
        ts.isNamedTupleMember(elem) ||
        ts.isOptionalTypeNode(elem) ||
        ts.isRestTypeNode(elem)
      ) {
        return undefined;
      }
      const name = this.directTypeParameterName(elem, names);
      if (!name) return undefined;
      if (found !== undefined && found !== name) return undefined;
      found = name;
    }
    return found;
  }

  arrayElementTypeParameterName(typeNode: ts.TypeNode | undefined, names: Set<string>): string | undefined {
    if (!typeNode) return undefined;
    if (ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) {
      return this.arrayElementTypeParameterName(typeNode.type, names);
    }
    if (ts.isArrayTypeNode(typeNode)) return this.directTypeParameterName(typeNode.elementType, names);
    if (ts.isTupleTypeNode(typeNode)) return this.tupleElementTypeParameterName(typeNode, names);
    if (
      ts.isTypeReferenceNode(typeNode) &&
      typeNode.typeArguments?.length === 1 &&
      (this.typeReferenceName(typeNode.typeName) === "Array" ||
       this.typeReferenceName(typeNode.typeName) === "ReadonlyArray")
    ) {
      return this.directTypeParameterName(typeNode.typeArguments[0], names);
    }
    return undefined;
  }

  genericInferencePattern(typeNode: ts.TypeNode | undefined, names: Set<string>): GenericInferencePattern | undefined {
    const direct = this.directTypeParameterName(typeNode, names);
    if (direct) return { kind: "direct", tpName: direct };
    const arrayElement = this.arrayElementTypeParameterName(typeNode, names);
    if (arrayElement) return { kind: "arrayElement", tpName: arrayElement };
    return undefined;
  }

  containsUncheckedTypeSyntax(node: ts.Node): boolean {
    let unsafe = false;
    const visit = (n: ts.Node) => {
      if (unsafe) return;
      if (
        ts.isAsExpression(n) ||
        ts.isTypeAssertionExpression(n) ||
        ts.isNonNullExpression(n) ||
        n.kind === ts.SyntaxKind.AnyKeyword ||
        n.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        unsafe = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return unsafe;
  }

  genericInferenceBodySafe(decl: ts.FunctionDeclaration): boolean {
    const cached = this.genericInferenceSafety.get(decl);
    if (cached !== undefined) return cached;
    let safe = true;
    const visit = (n: ts.Node) => {
      if (!safe) return;
      if (
        ts.isAsExpression(n) ||
        ts.isTypeAssertionExpression(n) ||
        ts.isNonNullExpression(n) ||
        n.kind === ts.SyntaxKind.AnyKeyword ||
        n.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        safe = false;
        return;
      }
      if (ts.isExpression(n)) {
        try {
          if (this.typeHasAnyOrUnknown(this.checker.getTypeAtLocation(n))) {
            safe = false;
            return;
          }
        } catch {
          // Keep the optimizer conservative if the checker cannot classify a node.
          safe = false;
          return;
        }
      }
      if (n !== decl && isFunctionLike(n)) return;
      ts.forEachChild(n, visit);
    };
    for (const p of decl.parameters) visit(p);
    if (decl.type) visit(decl.type);
    if (decl.body) visit(decl.body);
    this.genericInferenceSafety.set(decl, safe);
    return safe;
  }

  callArgumentsSafe(args: readonly ts.Expression[] | undefined): boolean {
    if (!args) return true;
    for (const arg of args) {
      if (this.containsUncheckedTypeSyntax(arg)) return false;
      try {
        if (this.typeHasAnyOrUnknown(this.checker.getTypeAtLocation(arg))) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  classInstanceSpecializationSourceSafe(expr: ts.Expression, seen = new Set<ts.Node>()): boolean {
    if (!this.strictTypeOptimizationsEnabled()) return false;
    let e: ts.Expression = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) return false;
    if (this.containsUncheckedTypeSyntax(e)) return false;
    if (ts.isNewExpression(e)) return this.callArgumentsSafe(e.arguments);
    if (!ts.isIdentifier(e)) return false;
    const sym = this.symbolOf(e);
    const decls = sym?.getDeclarations?.() ?? [];
    if (decls.length !== 1 || !ts.isVariableDeclaration(decls[0])) return false;
    const decl = decls[0];
    if (seen.has(decl)) return false;
    seen.add(decl);
    const list = decl.parent;
    const isConst = !!(list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const));
    if (!isConst || !decl.initializer) return false;
    return this.classInstanceSpecializationSourceSafe(decl.initializer, seen);
  }

  classTypeOptimizationSafe(decl: ts.ClassLikeDeclaration): boolean {
    const cached = this.genericInferenceSafety.get(decl as unknown as ts.FunctionDeclaration);
    if (cached !== undefined) return cached;
    let safe = true;
    const visit = (n: ts.Node) => {
      if (!safe) return;
      if (
        ts.isAsExpression(n) ||
        ts.isTypeAssertionExpression(n) ||
        ts.isNonNullExpression(n) ||
        n.kind === ts.SyntaxKind.AnyKeyword ||
        n.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        safe = false;
        return;
      }
      if (ts.isExpression(n)) {
        try {
          if (this.typeHasAnyOrUnknown(this.checker.getTypeAtLocation(n))) {
            safe = false;
            return;
          }
        } catch {
          safe = false;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(decl);
    this.genericInferenceSafety.set(decl as unknown as ts.FunctionDeclaration, safe);
    return safe;
  }

  inferGenericSpecializationArgs(
    node: ts.CallExpression,
    decl: ts.FunctionDeclaration,
    tparams: ts.NodeArray<ts.TypeParameterDeclaration>,
  ): Map<string, TypeSpec> | undefined {
    if (!this.strictTypeOptimizationsEnabled()) return undefined;
    if (!this.genericInferenceBodySafe(decl)) return undefined;
    const names = new Set(tparams.map((tp) => tp.name.text));
    const inferred = new Map<string, TypeSpec>();
    const paramCount = Math.min(node.arguments.length, decl.parameters.length);
    for (let i = 0; i < paramCount; i++) {
      const param = decl.parameters[i];
      if (param.dotDotDotToken || param.questionToken || param.initializer) continue;
      const pattern = this.genericInferencePattern(param.type, names);
      if (!pattern) continue;
      const arg = node.arguments[i];
      if (this.containsUncheckedTypeSyntax(arg)) return undefined;
      const argType = this.checker.getTypeAtLocation(arg);
      if (this.typeHasAnyOrUnknown(argType)) return undefined;
      const sourceType = pattern.kind === "direct"
        ? argType
        : this.checker.getIndexTypeOfType(argType, ts.IndexKind.Number);
      if (!sourceType || this.typeHasAnyOrUnknown(sourceType)) return undefined;
      const spec = this.typeSpecForType(sourceType);
      if (!spec) return undefined;
      if (spec.kind !== "number" && spec.kind !== "string" && spec.kind !== "array") return undefined;
      const prev = inferred.get(pattern.tpName);
      if (prev && prev.key !== spec.key) return undefined;
      inferred.set(pattern.tpName, spec);
    }
    for (const tp of tparams) {
      if (!inferred.has(tp.name.text)) return undefined;
    }
    return inferred;
  }

  genericSpecializationHasBenefit(decl: ts.FunctionDeclaration, subst: Map<string, TypeSpec>): boolean {
    for (const spec of subst.values()) {
      if (spec.refKind === "primitive") return true;
    }
    const savedSubst = this.typeSubst;
    this.typeSubst = subst;
    let useful = false;
    const visit = (n: ts.Node) => {
      if (useful) return;
      if (n !== decl && isFunctionLike(n)) return;
      if (ts.isPropertyAccessExpression(n)) {
        const rk = this.builtinReceiverKind(n.expression);
        if (n.name.text === "length" && (rk === "string" || rk === "array")) {
          useful = true;
          return;
        }
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const rk = this.builtinReceiverKind(n.expression.expression);
        if (rk !== undefined && this.builtinMethodName2(rk, n.expression.name.text) !== undefined) {
          useful = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    try {
      if (decl.body) visit(decl.body);
      return useful;
    } finally {
      this.typeSubst = savedSubst;
    }
  }

  specializeGenericCall(node: ts.CallExpression, fnSym: ts.Symbol): number | undefined {
    const decl = (fnSym.valueDeclaration ?? fnSym.declarations?.[0]) as ts.Node | undefined;
    if (!decl || !ts.isFunctionDeclaration(decl) || !decl.body) return undefined;
    const tparams = decl.typeParameters;
    if (!tparams || tparams.length === 0) return undefined; // not generic

    const hasExplicitTypeArgs = node.typeArguments !== undefined && node.typeArguments.length > 0;
    const inferred = hasExplicitTypeArgs ? undefined : this.inferGenericSpecializationArgs(node, decl, tparams);
    if (!hasExplicitTypeArgs && inferred === undefined) return undefined;
    if (hasExplicitTypeArgs) {
      if (!this.strictTypeOptimizationsEnabled()) return undefined;
      if (!this.genericInferenceBodySafe(decl)) return undefined;
      if (!this.callArgumentsSafe(node.arguments)) return undefined;
    }

    // Build name -> TypeSpec from explicit type args, or from strict-only inferred
    // call arguments when no explicit type args are present.
    const subst = new Map<string, TypeSpec>();
    const tagParts: string[] = [];
    for (let i = 0; i < tparams.length; i++) {
      const tpName = tparams[i].name.text;
      let spec: TypeSpec | undefined;
      if (hasExplicitTypeArgs && node.typeArguments?.[i]) {
        const concrete = this.checker.getTypeAtLocation(node.typeArguments[i]);
        spec = this.typeSpecForType(concrete);
      } else {
        spec = inferred?.get(tpName);
      }
      if (spec === undefined) return undefined;
      if (spec.kind !== "number" && spec.kind !== "string" && spec.kind !== "array" &&
          spec.kind !== "undefined" && spec.kind !== "null") return undefined;
      subst.set(tpName, spec);
      tagParts.push(`${tpName}=${spec.key}`);
    }
    if (!this.genericSpecializationHasBenefit(decl, subst)) return undefined;
    const key = `${this.fnId.get(decl)}|${tagParts.join(",")}`;
    const cached = this.genFnSpecializations.get(key);
    if (cached !== undefined) return cached;

    // Allocate a fresh, dense, contiguous fnId (shared allocator with class
    // method clones so ids never collide; the analyzer indexes functions by id).
    const specId = this.allocSpecFn();
    this.genFnSpecializations.set(key, specId);
    this.registerSpecNode(specId, decl);
    const savedSubst = this.typeSubst;
    this.typeSubst = subst;
    try {
      this.lowerFunctionLike(decl as FnLike, specId, false);
      // tag the emitted function's name so it's identifiable
      const emitted = this.functions.find((f) => f.id === specId);
      if (emitted) emitted.name = `${emitted.name}$${tagParts.map((p) => p.split("=")[1]).join("$")}`;
    } finally {
      this.typeSubst = savedSubst;
    }
    return specId;
  }

  /** Whole-program callback specialization: a call `f(a, cb)` whose argument
   *  `cb` names a module-level function and whose parameter is only ever
   *  called (or passed on to another module-level function) is routed to a
   *  clone of `f` lowered with that parameter bound to the function, so the
   *  clone calls it directly (and specializes its own callees in turn). The
   *  clone drops the bound parameters; the call site drops the arguments.
   *  Returns the clone id and the dropped argument indices, or undefined. */
  specializeCallbackCall(node: ts.CallExpression, fnSym: ts.Symbol): { func: number; dropped: Set<number> } | undefined {
    if (!this.callbackSpecEnabled) return undefined;
    const decl = (fnSym.valueDeclaration ?? fnSym.declarations?.[0]) as ts.Node | undefined;
    if (!decl || !ts.isFunctionDeclaration(decl) || !decl.body) return undefined;
    if (decl.asteriskToken || decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
    const fnId = this.funcSymbols.get(fnSym);
    if (fnId === undefined || this.nestedFuncSymbols.has(fnSym) || this.funcTakesThisIds.has(fnId)) return undefined;
    if (this.bodyUsesArguments(decl.body)) return undefined;
    const subst = new Map<ts.Symbol, ts.Symbol>();
    const dropped = new Set<number>();
    const tagParts: string[] = [];
    const n = Math.min(node.arguments.length, decl.parameters.length);
    for (let i = 0; i < n; i++) {
      const p = decl.parameters[i];
      const arg = node.arguments[i];
      if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.initializer || p.name.text === "this") continue;
      if (!ts.isIdentifier(arg)) continue;
      const target = this.resolveCallbackTarget(this.symbolOf(arg), decl);
      const dbg = process.env.TSAOT_SPECIALIZE_CALLBACKS_LOG === "2";
      if (!target) {
        if (dbg) {
          const s = this.symbolOf(arg);
          const d = s?.valueDeclaration ?? s?.declarations?.[0];
          const frees = d && ts.isFunctionDeclaration(d) ? this.sortedFreeVars(d as FnLike).map((v) => v.name).join(",") : "n/a";
          console.error(`[cbspec-skip] ${fnSym.name} arg ${i} '${arg.text}': sym=${s?.name} inFuncSymbols=${s ? this.funcSymbols.has(s) : false} frees=[${frees}]`);
        }
        continue;
      }
      const psym = this.symbolOf(p.name);
      if (!psym || this.assignedSyms.has(psym)) { if (dbg) console.error(`[cbspec-skip] ${fnSym.name} param ${i}: assigned`); continue; }
      if (!this.paramOnlyCalledOrPassed(decl.body, psym)) { if (dbg) console.error(`[cbspec-skip] ${fnSym.name} param ${i}: used otherwise`); continue; }
      subst.set(psym, target);
      dropped.add(i);
      tagParts.push(`${i}=${this.funcSymbols.get(target)}`);
    }
    if (subst.size === 0) return undefined;
    const key = `${fnId}|cb:${tagParts.join(",")}`;
    const cached = this.cbFnSpecializations.get(key);
    if (cached !== undefined) return { func: cached, dropped };
    const count = this.cbSpecCount.get(fnId) ?? 0;
    if (count >= this.maxCallbackSpecs) return undefined;
    this.cbSpecCount.set(fnId, count + 1);
    const specId = this.allocSpecFn();
    this.cbFnSpecializations.set(key, specId);
    this.registerSpecNode(specId, decl);
    const savedSubst = this.callbackSubst, savedType = this.typeSubst;
    this.callbackSubst = subst;
    this.typeSubst = undefined;
    try {
      this.lowerFunctionLike(decl as FnLike, specId, false);
      const emitted = this.functions.find((f) => f.id === specId);
      if (emitted) emitted.name = `${emitted.name}$cb$${[...subst.values()].map((s) => s.name).join("$")}`;
    } finally {
      this.callbackSubst = savedSubst;
      this.typeSubst = savedType;
    }
    if (process.env.TSAOT_SPECIALIZE_CALLBACKS_LOG) console.error(`[cbspec] ${key} -> ${specId}`);
    return { func: specId, dropped };
  }
  /** The module-level function a callback argument names (through an active substitution). */
  resolveCallbackTarget(sym: ts.Symbol | undefined, owner: ts.FunctionDeclaration): ts.Symbol | undefined {
    if (!sym) return undefined;
    const mapped = this.callbackSubst?.get(sym);
    if (mapped) sym = mapped;
    if (!this.funcSymbols.has(sym)) return undefined;
    const id = this.funcSymbols.get(sym)!;
    if (this.funcTakesThisIds.has(id)) return undefined;
    const d = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!d || !ts.isFunctionDeclaration(d) || !d.body) return undefined;
    // The clone calls the target directly and may box it as a value, so every
    // cell the target captures must be one the owner (hence the clone) holds.
    const need = this.sortedFreeVars(d as FnLike);
    if (need.length > 0) {
      const have = new Set(this.sortedFreeVars(owner as FnLike));
      if (!need.every((v) => have.has(v))) return undefined;
    }
    return sym;
  }
  bodyUsesArguments(body: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(n) && n.text === "arguments") { found = true; return; }
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) return;
      ts.forEachChild(n, visit);
    };
    visit(body);
    return found;
  }
  /** Every reference to `psym` in `body` is a callee, or an argument of a call
   *  whose callee names a module-level function (which specializes in turn),
   *  and at least one reference is a callee. */
  paramOnlyCalledOrPassed(body: ts.Node, psym: ts.Symbol): boolean {
    let ok = true, used = false;
    const visit = (n: ts.Node): void => {
      if (!ok) return;
      // a reference from a nested function would be a capture of a binding the
      // clone no longer has: keep such parameters on the generic path
      if (n !== body && (ts.isFunctionLike(n) || ts.isClassLike(n))) {
        let inner = false;
        const scan = (m: ts.Node): void => { if (inner) return; if (ts.isIdentifier(m) && this.symbolOf(m) === psym) inner = true; else ts.forEachChild(m, scan); };
        scan(n);
        if (inner) ok = false;
        return;
      }
      if (ts.isIdentifier(n) && this.symbolOf(n) === psym) {
        const parent = n.parent;
        if (ts.isCallExpression(parent) && parent.expression === n) { used = true; return; }
        if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === n) && ts.isIdentifier(parent.expression)) {
          const csym = this.symbolOf(parent.expression);
          if (csym && this.funcSymbols.has(csym) && !this.nestedFuncSymbols.has(csym)) { used = true; return; }
        }
        ok = false;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return ok && used;
  }

  /** Module-level function declarations with an explicit `this` parameter: the
   *  ES5 constructor functions a `new` through a function value may reach. */
  thisParamFnsStamp = -1;
  thisParamFunctions() {
    // recomputed whenever functions or their value globals were registered
    // since the last call (files are scanned and lowered in sequence)
    const stamp = this.funcSymbols.size * 7919 + this.functionValueGlobal.size;
    if (!this.thisParamFns || stamp !== this.thisParamFnsStamp) {
      this.thisParamFnsStamp = stamp;
      this.thisParamFns = [];
      for (const [sym] of this.funcSymbols) {
        const d = sym.valueDeclaration ?? sym.declarations?.[0];
        if (!d || !ts.isFunctionDeclaration(d) || !d.body || d.parameters.length === 0) continue;
        const p0 = d.parameters[0];
        if (!ts.isIdentifier(p0.name) || p0.name.text !== "this" || !p0.type) continue;
        if (d.asteriskToken || d.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
        if (!this.functionValueGlobal.has(sym)) continue;
        this.thisParamFns.push({ sym, decl: d, thisType: this.checker.getTypeFromTypeNode(p0.type), nparams: d.parameters.length - 1 });
      }
    }
    return this.thisParamFns;
  }
  /** The constructor functions a `new` site may reach, by the callee itself (through
   *  parentheses and assertions) or by the site's instance type against each
   *  constructor's `this` type; at most six, the one named like the callee first. */
  constructorCandidates(node: ts.NewExpression): ts.Symbol[] {
    if (!this.newGuardsEnabled) return [];
    const args = node.arguments ?? [];
    if (args.some((a) => ts.isSpreadElement(a))) return [];
    let callee: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) || ts.isTypeAssertionExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
    const fns = this.thisParamFunctions();
    const dbg = process.env.TSAOT_NEW_GUARDS_LOG === "1";
    if (fns.length === 0) { if (dbg) console.error(`[newguard] no this-param functions yet at ${node.getSourceFile().fileName}:${node.pos}`); return []; }
    if (ts.isIdentifier(callee)) {
      const s = this.symbolOf(callee);
      const direct = s && fns.find((f) => f.sym === s);
      if (dbg) console.error(`[newguard] callee '${callee.text}' sym=${s?.name} direct=${!!direct} inFuncSymbols=${s ? this.funcSymbols.has(s) : false} hasGlobal=${s ? this.functionValueGlobal.has(s) : false} args=${args.length}`);
      if (direct) return direct.nparams === args.length ? [direct.sym] : [];
    }
    let siteType: ts.Type | undefined;
    try { siteType = this.checker.getTypeAtLocation(node); } catch { return []; }
    if (!siteType || (siteType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never))) return [];
    const assignable = (this.checker as unknown as { isTypeAssignableTo?: (a: ts.Type, b: ts.Type) => boolean }).isTypeAssignableTo;
    if (!assignable) return [];
    const out: { sym: ts.Symbol; name: string }[] = [];
    for (const f of fns) {
      if (f.nparams !== args.length) continue;
      let ok = false;
      try { ok = assignable.call(this.checker, f.thisType, siteType) || assignable.call(this.checker, siteType, f.thisType); } catch { ok = false; }
      if (ok) out.push({ sym: f.sym, name: f.sym.name });
      if (out.length >= 6) break;
    }
    const calleeName = ts.isIdentifier(callee) ? callee.text : "";
    out.sort((a, b) => Number(calleeName.startsWith(b.name)) - Number(calleeName.startsWith(a.name)));
    return out.map((o) => o.sym);
  }
  /** `new <value>(args)`: the guard chain over the candidates, else the generic
   *  construction. Each hit allocates the instance, calls the constructor body
   *  directly with `this` = instance and applies the object-return rule. */
  emitNewMaybeGuarded(ctx: FnCtx, node: ts.NewExpression, ddst: number, callee: number, dargs: number[]): void {
    const cands = this.constructorCandidates(node);
    const emitChain = (i: number): void => {
      if (i >= cands.length) { ctx.body.push({ kind: "NewDynamic", dst: ddst, callee, args: dargs }); return; }
      const sym = cands[i];
      const fnId = this.funcSymbols.get(sym)!;
      const gref = this.functionValueGlobal.get(sym)!;
      const fval = this.newLocal(ctx, "reference", sym.name);
      ctx.body.push({ kind: "LoadGlobal", dst: fval, gref });
      const guard = this.newLocal(ctx, "reference", "ctorGuard");
      ctx.body.push({ kind: "CallBuiltinStatic", dst: guard, builtin: "construct.sameCode", args: [callee, fval] });
      const thenBody: any[] = [];
      const elseBody: any[] = [];
      const saved = ctx.body;
      ctx.body = thenBody;
      const inst = this.newLocal(ctx, "reference", "inst");
      const cap = this.constructorCapacity(sym);
      ctx.body.push({ kind: "CallBuiltinStatic", dst: inst, builtin: cap > 0 ? `construct.begin:${cap}` : "construct.begin", args: [callee] });
      const r = this.newLocal(ctx, "reference", "ctorResult");
      const cells = this.directCallCellArgs(ctx, fnId);
      if (cells.length > 0) ctx.body.push({ kind: "Call", dst: r, callee: { kind: "Direct", func: fnId }, args: [...cells, inst, ...dargs] });
      else ctx.body.push({ kind: "Call", dst: r, recv: inst, callee: { kind: "Direct", func: fnId }, args: dargs });
      const made = this.newLocal(ctx, "reference", "constructed");
      ctx.body.push({ kind: "CallBuiltinStatic", dst: made, builtin: "construct.end", args: [callee, inst, r] });
      ctx.body.push({ kind: "Copy", dst: ddst, src: made });
      ctx.body = elseBody;
      emitChain(i + 1);
      ctx.body = saved;
      ctx.body.push({ kind: "If", cond: guard, thenBody, elseBody });
    };
    emitChain(0);
  }

  /** Prefix layouts of the constructor functions (docs/static_slots_design.md):
   *  for each function declaration with an explicit `this` parameter, the keys
   *  of its leading `this.k = <pure>` statements (parameters, literals,
   *  `undefined`, enum members, casts and operators over those); a repeated or
   *  computed key or any other statement ends the prefix. The runtime adds the
   *  keys in that order, so key i sits at slot i of every instance the function
   *  initializes from an empty object. */
  constructorLayouts() {
    const stamp = this.funcSymbols.size;
    if (!this.ctorLayouts || stamp !== this.ctorLayoutsStamp) {
      this.ctorLayoutsStamp = stamp;
      this.ctorLayouts = [];
      this.staticSlotCands.clear();
      for (const [sym] of this.funcSymbols) {
        const d = sym.valueDeclaration ?? sym.declarations?.[0];
        if (!d || !ts.isFunctionDeclaration(d) || !d.body || d.parameters.length === 0) continue;
        const p0 = d.parameters[0];
        if (!ts.isIdentifier(p0.name) || p0.name.text !== "this" || !p0.type) continue;
        if (d.asteriskToken || d.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
        const params = new Set<ts.Symbol>();
        for (const p of d.parameters) {
          const ps = ts.isIdentifier(p.name) ? this.symbolOf(p.name) : undefined;
          if (ps) params.add(ps);
        }
        const keys: string[] = [];
        for (const st of d.body.statements) {
          if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression) ||
              st.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) break;
          const lhs = st.expression.left;
          if (!ts.isPropertyAccessExpression(lhs) || ts.isPrivateIdentifier(lhs.name)) break;
          let base: ts.Expression = lhs.expression;
          while (ts.isParenthesizedExpression(base) || ts.isAsExpression(base) || ts.isTypeAssertionExpression(base) || ts.isNonNullExpression(base)) base = base.expression;
          if (base.kind !== ts.SyntaxKind.ThisKeyword) break;
          const key = lhs.name.text;
          if (keys.includes(key) || !this.isPureInitializer(st.expression.right, params)) break;
          keys.push(key);
        }
        if (keys.length === 0) continue;
        let thisType: ts.Type;
        try { thisType = this.checker.getTypeFromTypeNode(p0.type); } catch { continue; }
        this.ctorLayouts.push({ sym, thisType, keys });
      }
    }
    return this.ctorLayouts;
  }
  /** An initializer that can neither run user code nor observe `this`. */
  private isPureInitializer(e: ts.Expression, params: Set<ts.Symbol>): boolean {
    if (ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
    if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(e)) {
      if (e.text === "undefined") return true;
      const sym = this.symbolOf(e);
      return sym !== undefined && params.has(sym);
    }
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
      return this.isPureInitializer(e.expression, params);
    }
    if (ts.isPrefixUnaryExpression(e)) return this.isPureInitializer(e.operand, params);
    if (ts.isPropertyAccessExpression(e)) {
      if (this.constEnumMemberValue(e) !== undefined) return true;
      const bs = ts.isIdentifier(e.expression) ? this.symbolOf(e.expression) : undefined;
      return bs !== undefined && (bs.flags & ts.SymbolFlags.Enum) !== 0;
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (k === ts.SyntaxKind.EqualsToken || k === ts.SyntaxKind.CommaToken ||
          (k >= ts.SyntaxKind.FirstCompoundAssignment && k <= ts.SyntaxKind.LastCompoundAssignment)) return false;
      return this.isPureInitializer(e.left, params) && this.isPureInitializer(e.right, params);
    }
    if (ts.isConditionalExpression(e)) {
      return this.isPureInitializer(e.condition, params) && this.isPureInitializer(e.whenTrue, params) && this.isPureInitializer(e.whenFalse, params);
    }
    return false;
  }
  /** The static-slot hint of `expr.key` (a read or a write): up to three
   *  predicted in-object slots, `(s1 + 1) | (s2 + 1) << 8 | (s3 + 1) << 16`, the
   *  slots of the receiver type's candidate producers that carry the key, the
   *  slot of more producers first; 0 when there is no prediction (no candidate
   *  carries the key, most candidates lack it, the slots are too spread, or a
   *  slot is at or beyond the runtime's limit). A prediction only: the emitted
   *  probe validates it against the receiver's shape. */
  staticSlotHint(expr: ts.Expression, key: string): number {
    if (!this.staticSlotsEnabled || this.producerLayouts().length === 0) return 0;
    let t: ts.Type | undefined;
    try { t = this.checker.getTypeAtLocation(expr); } catch { return 0; }
    if (!t) return 0;
    const cands = this.staticSlotCandidates(t);
    if (!cands || cands.length === 0) return 0;
    const counts = new Map<number, number>();
    let have = 0, lack = 0;
    for (const c of cands) {
      const slot = c.keys.indexOf(key);
      if (slot < 0) { lack++; continue; }
      have++;
      if (slot >= 16) return 0;
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
    if (have === 0 || lack > have) return 0;
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const top = ranked.slice(0, 3);
    let covered = 0;
    for (const [, n] of top) covered += n;
    if (covered * 5 < have * 4) return 0;
    const slots = top.map((e) => e[0]);
    if (process.env.TSAOT_STATIC_SLOTS_LOG === "1") {
      const k = `${key}@${slots.join(",")}`;
      this.staticSlotLog.set(k, (this.staticSlotLog.get(k) ?? 0) + 1);
    }
    return (slots[0] + 1) | (slots.length > 1 ? (slots[1] + 1) << 8 : 0) | (slots.length > 2 ? (slots[2] + 1) << 16 : 0);
  }
  /** The candidate producers of a receiver type: for each object member of the
   *  type (`undefined`/`null` members skipped), the producers whose type is the
   *  member's interface or class, one of its bases, or derived from it (the
   *  declared hierarchy, through `Mutable<T>` and type-parameter constraints);
   *  undefined when a member is not an object type (`any`, a primitive): no
   *  prediction. Cached by type id. */
  private staticSlotCandidates(t: ts.Type): ProducerLayout[] | undefined {
    const id = (t as unknown as { id?: number }).id;
    if (id !== undefined && this.staticSlotCands.has(id)) return this.staticSlotCands.get(id);
    let out: ProducerLayout[] | undefined = [];
    const members = t.isUnion() ? t.types : [t];
    const producers = this.producerLayouts();
    for (const m of members) {
      if (m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) continue;
      const rroots = this.typeRoots(m);
      if (rroots.length === 0 || !this.typeSyms(m)) { out = undefined; break; }
      // producers typed as the receiver's interface or a derived one
      let found = false;
      for (const l of producers) {
        if (out.includes(l) || !l.type) continue;
        const psyms = this.typeSyms(l.type);
        if (!psyms) continue;
        if (rroots.some((r) => psyms.has(r))) { out.push(l); found = true; }
      }
      // else the nearest base interfaces that have producers of their own
      // (a `StringLiteralType` receiver takes the `LiteralType` producers, not
      // every `Type` producer)
      const visited = new Set<ts.Symbol>(rroots);
      let level = this.directBases(rroots, visited);
      while (!found && level.length > 0) {
        for (const l of producers) {
          if (out.includes(l) || !l.type) continue;
          if (this.typeRoots(l.type).some((r) => level.includes(r))) { out.push(l); found = true; }
        }
        level = this.directBases(level, visited);
      }
    }
    if (id !== undefined) this.staticSlotCands.set(id, out);
    return out;
  }
  /** The direct base interfaces/classes of the given symbols, not yet visited. */
  private directBases(syms: ts.Symbol[], visited: Set<ts.Symbol>): ts.Symbol[] {
    const out: ts.Symbol[] = [];
    for (const sym of syms) {
      let decl: ts.Type | undefined;
      try { decl = this.checker.getDeclaredTypeOfSymbol(sym); } catch { decl = undefined; }
      if (!decl || !(decl.flags & ts.TypeFlags.Object)) continue;
      let bases: ts.BaseType[] = [];
      try { bases = this.checker.getBaseTypes(decl as ts.InterfaceType); } catch { bases = []; }
      for (const b of bases) for (const r of this.typeRoots(b)) if (!visited.has(r)) { visited.add(r); out.push(r); }
    }
    return out;
  }
  /** The interface/class symbols a type is declared as (through `Mutable<T>`,
   *  type-parameter constraints, unions and intersections). */
  private typeRoots(t: ts.Type): ts.Symbol[] {
    const out: ts.Symbol[] = [];
    const visit = (x: ts.Type, depth: number): void => {
      if (depth > 8) return;
      if (x.aliasSymbol && x.aliasSymbol.name === "Mutable" && x.aliasTypeArguments && x.aliasTypeArguments.length === 1) { visit(x.aliasTypeArguments[0], depth + 1); return; }
      if (x.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)) { for (const m of (x as ts.UnionOrIntersectionType).types) visit(m, depth + 1); return; }
      if (x.flags & ts.TypeFlags.TypeParameter) {
        let c: ts.Type | undefined;
        try { c = this.checker.getBaseConstraintOfType(x); } catch { c = undefined; }
        if (c && c !== x) visit(c, depth + 1);
        return;
      }
      if (x.flags & ts.TypeFlags.Object) {
        const sym = x.getSymbol();
        if (sym && (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) && !out.includes(sym)) out.push(sym);
      }
    };
    visit(t, 0);
    return out;
  }
  /** The roots of a type and all their base interfaces/classes, transitively;
   *  undefined when the type has no declared root (an `any`, a primitive, an
   *  anonymous object type). Cached by type id. */
  private typeSyms(t: ts.Type): Set<ts.Symbol> | undefined {
    const id = (t as unknown as { id?: number }).id;
    if (id !== undefined && this.typeSymsCache.has(id)) return this.typeSymsCache.get(id);
    const roots = this.typeRoots(t);
    let out: Set<ts.Symbol> | undefined;
    if (roots.length > 0) {
      out = new Set<ts.Symbol>();
      const work = [...roots];
      while (work.length > 0) {
        const sym = work.pop()!;
        if (out.has(sym)) continue;
        out.add(sym);
        let decl: ts.Type | undefined;
        try { decl = this.checker.getDeclaredTypeOfSymbol(sym); } catch { decl = undefined; }
        if (!decl || !(decl.flags & ts.TypeFlags.Object)) continue;
        let bases: ts.BaseType[] = [];
        try { bases = this.checker.getBaseTypes(decl as ts.InterfaceType); } catch { bases = []; }
        for (const b of bases) for (const r of this.typeRoots(b)) work.push(r);
      }
    }
    if (id !== undefined) this.typeSymsCache.set(id, out);
    return out;
  }
  /** Every producer layout of the program: the constructor prefix layouts and
   *  the fresh-object store sequences of every function body (a `const`/`let`
   *  initialized or assigned from a construction or a producer call, followed by
   *  `x.k = ..` stores before the object escapes), typed by the variable or by
   *  the producer function's return type. Recomputed per registration stamp. */
  producerLayouts(): ProducerLayout[] {
    const stamp = this.funcSymbols.size;
    if (this.producerLayoutsCache && stamp === this.producerLayoutsStamp) return this.producerLayoutsCache;
    this.producerLayoutsStamp = stamp;
    this.staticSlotCands.clear();
    this.returnLayoutMemo.clear();
    const out: ProducerLayout[] = [];
    for (const l of this.constructorLayouts()) out.push({ name: l.sym.name, type: l.thisType, keys: l.keys, ctor: l.sym });
    this.producerLayoutsCache = out;
    this.methodImpls = this.collectMethodImpls();
    const seen = new Set<string>();
    const add = (name: string, type: ts.Type | undefined, keys: string[]): void => {
      if (keys.length === 0 || !type) return;
      const id = (type as unknown as { id?: number }).id ?? -1;
      const k = `${id}|${keys.join(",")}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ name, type, keys });
    };
    const literals = this.literalProducersEnabled;
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const visit = (n: ts.Node): void => {
        if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) this.scanSequences(n.statements, add);
        // an object literal builds its keys in source order: a producer of its
        // contextual type (the declared variable, the return type, the
        // parameter or element type it is passed as)
        if (literals && ts.isObjectLiteralExpression(n)) {
          const keys = this.literalLayoutKeys(n);
          if (keys) {
            let ct: ts.Type | undefined;
            try { ct = this.checker.getContextualType(n) ?? undefined; } catch { ct = undefined; }
            add("literal", ct, keys);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return out;
  }
  /** TSAOT_LITERAL_PRODUCERS=0: object literals are not producer layouts. */
  private literalProducersEnabled = process.env.TSAOT_LITERAL_PRODUCERS !== "0";
  /** The key order of the object an object literal builds, when every property
   *  has a static name that is not an array index (no spread, computed key,
   *  accessor or `__proto__`): source order, a repeated key at its first
   *  position (docs/static_slots_design.md, literal producers). */
  private literalLayoutKeys(lit: ts.ObjectLiteralExpression): string[] | undefined {
    const keys: string[] = [];
    for (const p of lit.properties) {
      let name: string;
      if (ts.isShorthandPropertyAssignment(p)) name = p.name.text;
      else if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) name = p.name.text;
      else return undefined;
      if (name === "__proto__" || /^[0-9]+$/.test(name)) return undefined;
      if (!keys.includes(name)) keys.push(name);
    }
    return keys.length > 0 ? keys : undefined;
  }
  /** Object-literal properties bound to function declarations, by property
   *  name: `{ m }`, `{ m: f }`, `{ m() {..} }`; the method-call resolution of
   *  producer calls (`obj.m(..)`) uses a name bound exactly once. */
  private collectMethodImpls(): Map<string, ts.FunctionLikeDeclaration[]> {
    const out = new Map<string, ts.FunctionLikeDeclaration[]>();
    const push = (name: string, f: ts.FunctionLikeDeclaration): void => {
      const arr = out.get(name);
      if (arr) { if (!arr.includes(f)) arr.push(f); } else out.set(name, [f]);
    };
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const visit = (n: ts.Node): void => {
        if (ts.isObjectLiteralExpression(n)) {
          for (const prop of n.properties) {
            if (ts.isShorthandPropertyAssignment(prop)) {
              // the property symbol is not the value's: resolve the referenced binding
              let vs: ts.Symbol | undefined;
              try { vs = this.checker.getShorthandAssignmentValueSymbol(prop); } catch { vs = undefined; }
              const d = vs ? this.functionDeclOfSymbol(vs) : undefined;
              if (d) push(prop.name.text, d);
            } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
              let init: ts.Expression = prop.initializer;
              while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
              if (ts.isIdentifier(init)) { const d = this.functionDeclOfIdentifier(init); if (d) push(prop.name.text, d); }
              else if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) push(prop.name.text, init);
            } else if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name) && prop.body) {
              push(prop.name.text, prop);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return out;
  }
  private functionDeclOfIdentifier(id: ts.Identifier): ts.FunctionLikeDeclaration | undefined {
    return this.functionDeclOfSymbol(this.symbolOf(id));
  }
  private functionDeclOfSymbol(sym: ts.Symbol | undefined): ts.FunctionLikeDeclaration | undefined {
    const d = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!d) return undefined;
    if (ts.isFunctionDeclaration(d) && d.body) return d;
    if (ts.isVariableDeclaration(d) && d.initializer) {
      let init: ts.Expression = d.initializer;
      while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return init;
    }
    return undefined;
  }
  /** The key lists of the fresh objects a producer expression yields (through
   *  parentheses and assertions): a construction (its predicted constructor
   *  layouts: the candidate named like the callee, else every candidate) or a
   *  call to a function with return layouts (an identifier, or a method name
   *  bound to exactly one function). */
  private producerExprLayouts(e: ts.Expression, depth: number): string[][] | undefined {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    if (this.literalProducersEnabled && ts.isObjectLiteralExpression(e)) {
      const keys = this.literalLayoutKeys(e);
      return keys ? [keys] : undefined;
    }
    if (ts.isNewExpression(e)) {
      const cands = this.constructorCandidates(e);
      if (cands.length === 0) return undefined;
      let callee: ts.Expression = e.expression;
      for (;;) {
        if (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) || ts.isTypeAssertionExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
        else if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.BarBarToken) callee = callee.left;
        else break;
      }
      const layouts = this.constructorLayouts();
      const calleeName = ts.isIdentifier(callee) ? callee.text : "";
      const named = calleeName ? cands.filter((c) => calleeName === c.name || calleeName.startsWith(c.name)) : [];
      const chosen = named.length > 0 ? named.slice(0, 1) : cands;
      const out: string[][] = [];
      for (const c of chosen) { const l = layouts.find((x) => x.sym === c); if (l) out.push(l.keys); }
      return out.length > 0 ? out : undefined;
    }
    if (ts.isCallExpression(e)) {
      let callee: ts.Expression = e.expression;
      while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
      if (ts.isIdentifier(callee)) {
        const decl = this.functionDeclOfIdentifier(callee);
        return decl ? this.returnLayoutsOf(decl, depth + 1) ?? undefined : undefined;
      }
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        // every function bound to a property of that name anywhere in the
        // program (the base node factory has three `createBaseNode` bindings,
        // all producing the same layout); the union of their return layouts
        const impls = this.methodImpls?.get(callee.name.text);
        if (!impls || impls.length === 0 || impls.length > 8) return undefined;
        const out: string[][] = [];
        const seen = new Set<string>();
        for (const d of impls) {
          const r = this.returnLayoutsOf(d, depth + 1);
          if (!r) continue;
          for (const k of r) { const key = k.join(","); if (!seen.has(key)) { seen.add(key); out.push(k); } }
        }
        return out.length > 0 ? out : undefined;
      }
      return undefined;
    }
    return undefined;
  }
  /** The key lists of the fresh objects a function returns: `return <producer>`
   *  statements and the sequences of variables it returns. Memoized; null while
   *  being computed (recursion) and when the function is not a producer. */
  private returnLayoutsOf(fn: ts.FunctionLikeDeclaration, depth: number): string[][] | null {
    if (depth > 12) return null;
    const memo = this.returnLayoutMemo.get(fn);
    if (memo !== undefined) return memo;
    this.returnLayoutMemo.set(fn, null);
    const body = fn.body;
    if (!body) return null;
    const out: string[][] = [];
    const seen = new Set<string>();
    const addAll = (ls: string[][] | undefined): void => {
      if (!ls) return;
      for (const k of ls) { const key = k.join(","); if (!seen.has(key)) { seen.add(key); out.push(k); } }
    };
    if (!ts.isBlock(body)) {
      addAll(this.producerExprLayouts(body, depth));
    } else {
      const returned = new Set<ts.Symbol>();
      const findReturns = (n: ts.Node): void => {
        if (ts.isFunctionLike(n) && n !== fn) return;
        if (ts.isReturnStatement(n) && n.expression) {
          let e: ts.Expression = n.expression;
          while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
          if (ts.isIdentifier(e)) { const sym = this.symbolOf(e); if (sym) returned.add(sym); }
          else addAll(this.producerExprLayouts(e, depth));
        }
        ts.forEachChild(n, findReturns);
      };
      findReturns(body);
      if (returned.size > 0) {
        const visit = (n: ts.Node): void => {
          if (ts.isFunctionLike(n) && n !== fn) return;
          if (ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
            this.scanSequences(n.statements, (_name, _type, keys, sym) => { if (sym && returned.has(sym)) addAll([keys]); }, depth);
          }
          ts.forEachChild(n, visit);
        };
        visit(body);
      }
    }
    const result = out.length > 0 ? out : null;
    this.returnLayoutMemo.set(fn, result);
    return result;
  }
  /** Fresh-object store sequences in a statement list: `const|let x = P(..)` or
   *  `x = P(..)` with P a producer expression, then the following statements:
   *  `x.k = ..` appends a new key (`x.k op= ..` as well), a statement that does
   *  not let `x` escape is skipped, an `if` whose branches store only existing
   *  keys is skipped, and anything else ends the sequence. The sequence is
   *  reported with the variable's declared type, or the initializer's type when
   *  the variable has no annotation. */
  private scanSequences(stmts: readonly ts.Statement[], report: (name: string, type: ts.Type | undefined, keys: string[], sym?: ts.Symbol) => void, depth = 0): void {
    for (let i = 0; i < stmts.length; i++) {
      const st = stmts[i];
      let xSym: ts.Symbol | undefined, xName: string | undefined, init: ts.Expression | undefined, typeNode: ts.Node | undefined;
      if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
        const d = st.declarationList.declarations[0];
        if (ts.isIdentifier(d.name) && d.initializer) { xSym = this.symbolOf(d.name); xName = d.name.text; init = d.initializer; typeNode = d.type ? d.name : d.initializer; }
      } else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(st.expression.left)) {
        xSym = this.symbolOf(st.expression.left); xName = st.expression.left.text; init = st.expression.right; typeNode = st.expression.right;
      }
      if (!xSym || !init || !xName) continue;
      const bases = this.producerExprLayouts(init, depth);
      if (!bases) continue;
      const keys: string[][] = bases.map((b) => b.slice());
      const has = (k: string): boolean => keys.every((l) => l.includes(k));
      const append = (k: string): void => { for (const l of keys) if (!l.includes(k)) l.push(k); };
      for (let j = i + 1; j < stmts.length; j++) {
        const t = stmts[j];
        const store = this.storeOnVar(t, xSym);
        if (store) {
          if (!has(store.key)) append(store.key);
          if (store.escapes) break;
          continue;
        }
        if (ts.isReturnStatement(t)) break;
        if (ts.isIfStatement(t)) {
          let ok = !this.escapesVar(t.expression, xSym);
          for (const b of [t.thenStatement, t.elseStatement]) {
            if (!ok || !b) continue;
            for (const inner of (ts.isBlock(b) ? b.statements : [b])) {
              const s2 = this.storeOnVar(inner, xSym);
              if (s2) { if (s2.escapes || !has(s2.key)) { ok = false; break; } continue; }
              if (this.escapesVar(inner, xSym)) { ok = false; break; }
            }
          }
          if (!ok) break;
          continue;
        }
        if (this.escapesVar(t, xSym)) break;
      }
      let type: ts.Type | undefined;
      try { type = typeNode ? this.checker.getTypeAtLocation(typeNode) : undefined; } catch { type = undefined; }
      for (const l of keys) report(xName, type, l, xSym);
    }
  }
  /** `x.k = e` / `x.k op= e` as a statement: the key, and whether the right side
   *  lets `x` escape. */
  private storeOnVar(st: ts.Statement, x: ts.Symbol): { key: string; escapes: boolean } | undefined {
    if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) return undefined;
    const be = st.expression;
    const k = be.operatorToken.kind;
    const isAssign = k === ts.SyntaxKind.EqualsToken || (k >= ts.SyntaxKind.FirstCompoundAssignment && k <= ts.SyntaxKind.LastCompoundAssignment);
    if (!isAssign) return undefined;
    let lhs: ts.Expression = be.left;
    while (ts.isParenthesizedExpression(lhs)) lhs = lhs.expression;
    if (!ts.isPropertyAccessExpression(lhs) || ts.isPrivateIdentifier(lhs.name)) return undefined;
    let base: ts.Expression = lhs.expression;
    while (ts.isParenthesizedExpression(base) || ts.isAsExpression(base) || ts.isTypeAssertionExpression(base) || ts.isNonNullExpression(base)) base = base.expression;
    if (!ts.isIdentifier(base) || this.symbolOf(base) !== x) return undefined;
    return { key: lhs.name.text, escapes: this.escapesVar(be.right, x) };
  }
  /** Whether `x` escapes in a node: passed to a call or construction, used as a
   *  callee or method receiver, placed in a literal, assigned, returned or
   *  thrown, or captured by a nested function or class. Property reads and
   *  writes on `x`, comparisons and tests do not count, nor does a value that
   *  flows into one of `x`'s own properties. */
  private escapesVar(node: ts.Node, x: ts.Symbol): boolean {
    let esc = false;
    const visit = (n: ts.Node): void => {
      if (esc) return;
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) { if (this.referencesVar(n, x)) esc = true; return; }
      if (ts.isIdentifier(n) && this.symbolOf(n) === x) {
        let p: ts.Node = n.parent, child: ts.Node = n;
        while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p)) { child = p; p = p.parent; }
        if (ts.isPropertyAccessExpression(p) && p.expression === child) {
          const call = p.parent;
          if (ts.isCallExpression(call) && call.expression === p) esc = true;
          return;
        }
        if (ts.isBinaryExpression(p)) {
          const k = p.operatorToken.kind;
          if (k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken) return;
          if ((k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.AmpersandAmpersandToken) && this.flowsIntoOwnStore(p, x)) return;
        }
        if (ts.isConditionalExpression(p) && (p.condition === child || this.flowsIntoOwnStore(p, x))) return;
        if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return;
        if (ts.isIfStatement(p) || ts.isWhileStatement(p)) return;
        esc = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return esc;
  }
  /** An expression whose value is stored into a property of `x` itself
   *  (`x.k = y || x`): the object does not leave the sequence. */
  private flowsIntoOwnStore(e: ts.Node, x: ts.Symbol): boolean {
    let p: ts.Node = e.parent, child: ts.Node = e;
    while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.BarBarToken || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) || ts.isConditionalExpression(p)) { child = p; p = p.parent; }
    if (!ts.isBinaryExpression(p) || p.right !== child || p.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    let lhs: ts.Expression = p.left;
    while (ts.isParenthesizedExpression(lhs)) lhs = lhs.expression;
    if (!ts.isPropertyAccessExpression(lhs)) return false;
    let base: ts.Expression = lhs.expression;
    while (ts.isParenthesizedExpression(base) || ts.isAsExpression(base) || ts.isNonNullExpression(base)) base = base.expression;
    return ts.isIdentifier(base) && this.symbolOf(base) === x;
  }
  private referencesVar(node: ts.Node, x: ts.Symbol): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(n) && this.symbolOf(n) === x) { found = true; return; }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  }
  printStaticSlotLog(): void {
    if (process.env.TSAOT_STATIC_SLOTS_LOG !== "1") return;
    const rows = [...this.staticSlotLog.entries()].sort((a, b) => b[1] - a[1]);
    let total = 0;
    for (const [, n] of rows) total += n;
    const producers = this.producerLayoutsCache ?? [];
    console.error(`[static-slots] ${total} hinted sites; ${producers.length} producers; constructors: ${(this.ctorLayouts ?? []).map((l) => `${l.sym.name}[${l.keys.join(",")}]`).join(" ")}`);
    if (process.env.TSAOT_STATIC_SLOTS_LOG_PRODUCERS === "1") for (const p of producers) console.error(`[static-slots] producer ${p.name}: ${p.keys.join(",")}`);
    const limit = Number(process.env.TSAOT_STATIC_SLOTS_LOG_ROWS ?? "60") || 60;
    for (const [k, n] of rows.slice(0, limit)) console.error(`[static-slots] ${n}\t${k}`);
  }
  /** The in-object capacity for the instances of a constructor function: the
   *  longest producer layout that starts with its prefix (the keys the program
   *  adds right after construction), plus two, at most `TSAOT_CTOR_CAPACITY`;
   *  0 when off (the default) or when the constructor has no prefix layout. */
  constructorCapacity(sym: ts.Symbol): number {
    if (!this.staticSlotsEnabled || this.ctorCapacityLimit <= 0) return 0;
    const cached = this.ctorCapacityCache.get(sym);
    if (cached !== undefined) return cached;
    const ctor = this.constructorLayouts().find((l) => l.sym === sym);
    let max = 0;
    if (ctor) {
      for (const p of this.producerLayouts()) {
        if (p.keys.length <= ctor.keys.length) continue;
        let prefix = true;
        for (let i = 0; i < ctor.keys.length; i++) if (p.keys[i] !== ctor.keys[i]) { prefix = false; break; }
        if (prefix && p.keys.length > max) max = p.keys.length;
      }
    }
    const cap = max > 0 ? Math.min(max + 2, this.ctorCapacityLimit) : 0;
    this.ctorCapacityCache.set(sym, cap);
    return cap;
  }
  ctorCapacityCache = new Map<ts.Symbol, number>();
  /** `TSAOT_CTOR_CAPACITY=N`: pre-size guarded constructions to their longest
   *  producer layout, at most N in-object slots. Off by default: at 16 it cut the
   *  static misses but cost a tenth of the compiler's memory for no measurable
   *  time (the static probe reads external slots instead). */
  ctorCapacityLimit = Math.max(0, Number(process.env.TSAOT_CTOR_CAPACITY ?? "0") || 0);
  /** Attach a non-zero hint to a LoadField/StoreField. */
  private withSlots<T extends { kind: string }>(inst: T, slots: number): T {
    if (slots) (inst as unknown as { slots?: number }).slots = slots;
    return inst;
  }

  /** Counter for specialized-function ids (cloned methods), dense above assigned. */
  specBase = -1;

  /** Per class: field name -> set of concrete scalar type tags seen across all
   *  `new C<...>()` sites. Used for monomorphization (uniform -> specialize). */
  instFieldTypes = new Map<number, Map<string, Set<string>>>();
  /** Field declarations (property declarations, parameter properties) stored
   *  unsafely somewhere in the program, and class declarations stored into
   *  dynamically (docs/field_store_safety_design.md). A typed field is mis-set
   *  only by a store, so these decide a field's representation; reads through
   *  casts (`this as unknown as Sub`) leave it typed. */
  unsafeFieldDecls = new Set<ts.Node>();
  unsafeStoreClasses = new Set<ts.Node>();
  /** Variables with a store the checker cannot vouch for (a cast, an `any`,
   *  a destructuring target): their capture-context fields stay boxed
   *  (docs/int32_fields_design.md, "Typed capture-context fields"). */
  unsafeVarSyms = new Set<ts.Symbol>();
  collectUnsafeFieldStores(): void {
    if (!this.strictTypeOptimizationsEnabled()) return;
    const unwrap = (e: ts.Expression): ts.Expression => {
      for (;;) {
        if (ts.isParenthesizedExpression(e)) e = e.expression;
        else if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
        else return e;
      }
    };
    const classDeclOfType = (t: ts.Type | undefined): ts.Node | undefined => {
      const sym = t?.getSymbol?.();
      for (const d of sym?.declarations ?? []) if (ts.isClassLike(d)) return d;
      return undefined;
    };
    // The stored value is unsafe when a cast or a non-null assertion sits on
    // its own path (the expression itself, a branch of a conditional, an
    // operand of `??`, `||`, `&&`, the last of a comma) or its type has any or
    // unknown. A cast elsewhere in the expression, on the receiver of a
    // property read (`(x as T).pos`) or in a call's argument, leaves the value's
    // declared type, which the field's own typing and the callee's signature
    // vouch for; tsc-ts's parser stores `node.pos = (type as T).pos` constantly.
    const valueUnsafe = (rhs: ts.Expression): boolean => {
      let e: ts.Expression = rhs;
      for (;;) {
        if (ts.isParenthesizedExpression(e)) { e = e.expression; continue; }
        if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) return true;
        if (ts.isConditionalExpression(e)) return valueUnsafe(e.whenTrue) || valueUnsafe(e.whenFalse);
        if (ts.isBinaryExpression(e)) {
          const k = e.operatorToken.kind;
          if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken) return valueUnsafe(e.left) || valueUnsafe(e.right);
          if (k === ts.SyntaxKind.CommaToken) { e = e.right; continue; }
          if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) { e = e.right; continue; }
        }
        break;
      }
      try { return this.typeHasAnyOrUnknown(this.checker.getTypeAtLocation(e)); } catch { return true; }
    };
    const markField = (name: ts.MemberName, force: boolean, rhs: ts.Expression | undefined) => {
      const sym = this.symbolOf(name);
      const decls = (sym?.declarations ?? []).filter((d) => ts.isPropertyDeclaration(d) || (ts.isParameter(d) && ts.isConstructorDeclaration(d.parent)));
      if (decls.length === 0) return;
      if (force || !rhs || valueUnsafe(rhs)) {
        for (const d of decls) this.unsafeFieldDecls.add(d);
        if (process.env.TSAOT_DEBUG_FIELD_SAFETY) {
          const sf = name.getSourceFile(); const pos = sf.getLineAndCharacterOfPosition(name.getStart());
          const owner = decls[0].parent && ts.isClassLike(decls[0].parent) ? (decls[0].parent.name?.text ?? "?") : (ts.isConstructorDeclaration(decls[0].parent) ? (decls[0].parent.parent as ts.ClassLikeDeclaration).name?.text ?? "?" : "?");
          console.error(`[field-safety] ${owner}.${name.getText()} unsafe at ${sf.fileName}:${pos.line + 1} ${force ? "(forced)" : rhs ? rhs.getText().slice(0, 60) : ""}`);
        }
      }
    };
    const markObjectDynamic = (obj: ts.Expression) => {
      // the receiver's class before any cast: `(x as any)[k] = v` stores into x's class
      let t: ts.Type | undefined;
      try { t = this.checker.getTypeAtLocation(unwrap(obj)); } catch { t = undefined; }
      const d = classDeclOfType(t);
      if (d) {
        this.unsafeStoreClasses.add(d);
        if (process.env.TSAOT_DEBUG_FIELD_SAFETY) console.error(`[field-safety] class ${(d as ts.ClassLikeDeclaration).name?.text ?? "?"} stored dynamically at ${obj.getSourceFile().fileName}:${obj.getSourceFile().getLineAndCharacterOfPosition(obj.getStart()).line + 1}`);
      }
    };
    const markVar = (name: ts.Identifier, force: boolean, rhs: ts.Expression | undefined) => {
      const sym = this.symbolOf(name);
      if (!sym) return;
      if (force || !rhs || valueUnsafe(rhs)) this.unsafeVarSyms.add(sym);
    };
    const markPattern = (name: ts.BindingName) => {
      if (ts.isIdentifier(name)) { const sym = this.symbolOf(name); if (sym) this.unsafeVarSyms.add(sym); return; }
      for (const el of name.elements) if (ts.isBindingElement(el)) markPattern(el.name);
    };
    const markTarget = (target: ts.Expression, rhs: ts.Expression | undefined, force: boolean) => {
      const t = unwrap(target);
      if (ts.isIdentifier(t)) markVar(t, force, rhs);
      else if (ts.isPropertyAccessExpression(t)) markField(t.name, force, rhs);
      else if (ts.isElementAccessExpression(t)) markObjectDynamic(t.expression);
      else if (ts.isObjectLiteralExpression(t)) {
        // a destructuring target: the values come from a shape the checker does
        // not relate to the fields; every field target is unsafe
        for (const p of t.properties) {
          if (ts.isPropertyAssignment(p)) markTarget(p.initializer, undefined, true);
          else if (ts.isShorthandPropertyAssignment(p) && p.objectAssignmentInitializer) markTarget(p.objectAssignmentInitializer, undefined, true);
          else if (ts.isSpreadAssignment(p)) markTarget(p.expression, undefined, true);
        }
      } else if (ts.isArrayLiteralExpression(t)) {
        for (const e of t.elements) {
          if (ts.isOmittedExpression(e)) continue;
          if (ts.isSpreadElement(e)) markTarget(e.expression, undefined, true);
          else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) markTarget(e.left, undefined, true);
          else markTarget(e, undefined, true);
        }
      }
    };
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) markTarget(n.left, n.right, false);
      } else if (ts.isDeleteExpression(n)) {
        markTarget(n.expression, undefined, true);
      } else if (ts.isCallExpression(n)) {
        // Object.assign(x, ...): x's class stored into dynamically
        const callee = n.expression;
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && callee.name.text === "assign" && n.arguments.length > 0)
          markObjectDynamic(n.arguments[0]);
      } else if (ts.isForInStatement(n) || ts.isForOfStatement(n)) {
        if (!ts.isVariableDeclarationList(n.initializer)) markTarget(n.initializer, undefined, true);
      } else if (ts.isVariableDeclaration(n)) {
        // a declaration's initializer is a store too; a destructuring
        // declaration gives its names values the checker does not relate
        if (ts.isIdentifier(n.name)) { if (n.initializer) markVar(n.name, false, n.initializer); }
        else markPattern(n.name);
      } else if (ts.isParameter(n) && !ts.isIdentifier(n.name)) {
        markPattern(n.name);
      }
      ts.forEachChild(n, visit);
    };
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      visit(sf);
    }
  }
  /** Active type-parameter substitution while lowering/scanning a specialized
   *  generic body: type-param name -> concrete TypeSpec. */
  typeSubst: Map<string, TypeSpec> | undefined = undefined;
  /** Cache of generic-function specializations: "fnId|tag" -> specialized fnId. */
  genFnSpecializations = new Map<string, number>();
  /** Callback specialization (docs/whole_program_facts_design.md, item 1):
   *  while lowering a clone, parameter symbol -> the module-level function
   *  symbol bound at the specializing call site. */
  callbackSubst: Map<ts.Symbol, ts.Symbol> | undefined = undefined;
  /** Cache: "fnId|cb:i=targetFnId,..." -> specialized fnId. */
  cbFnSpecializations = new Map<string, number>();
  /** Clones per original function (cap). */
  cbSpecCount = new Map<number, number>();
  maxCallbackSpecs = 16;
  callbackSpecEnabled = process.env.TSAOT_SPECIALIZE_CALLBACKS !== "0";
  /** Guarded direct construction (docs/guarded_construction_design.md): off
   *  under the oracle knob and in untyped mode (the candidates come from types). */
  newGuardsEnabled = process.env.TSAOT_NEW_GUARDS !== "0" && process.env.TSAOT_UNTYPED !== "1";
  thisParamFns: { sym: ts.Symbol; decl: ts.FunctionDeclaration; thisType: ts.Type; nparams: number }[] | undefined = undefined;
  /** Static slots (docs/static_slots_design.md): off under the oracle knob and
   *  in untyped mode (the predictions come from the receiver types). */
  staticSlotsEnabled = process.env.TSAOT_STATIC_SLOTS !== "0" && process.env.TSAOT_UNTYPED !== "1";
  ctorLayouts: { sym: ts.Symbol; thisType: ts.Type; keys: string[] }[] | undefined = undefined;
  ctorLayoutsStamp = -1;
  /** Receiver type id -> its candidate layouts (undefined: no prediction). */
  staticSlotCands = new Map<number, ProducerLayout[] | undefined>();
  /** Producer layouts (docs/static_slots_design.md, producers): the constructor
   *  prefix layouts plus every fresh-object store sequence of the program
   *  (`const x = new C(..) | f(..)` followed by `x.k = ..` stores), computed
   *  once per registration stamp. */
  producerLayoutsCache: ProducerLayout[] | undefined = undefined;
  producerLayoutsStamp = -1;
  /** Function declaration -> the key lists its returned fresh objects carry
   *  (null while computing or when it is not a producer). */
  returnLayoutMemo = new Map<ts.Node, string[][] | null>();
  /** Object-literal property name -> the function declarations bound to it. */
  methodImpls: Map<string, ts.FunctionLikeDeclaration[]> | undefined = undefined;
  /** Type id -> the interface/class symbols of the type and its bases. */
  typeSymsCache = new Map<number, Set<ts.Symbol> | undefined>();
  /** `key@slots` -> hinted sites, for TSAOT_STATIC_SLOTS_LOG=1. */
  staticSlotLog = new Map<string, number>();

  /** Record the resolved concrete type of each field for one `new C<...>()`. */
  /** Lower a class's field initializers (`class C { a = <expr> }`) as StoreField
   *  on the freshly-constructed object `dst`, in declaration order (§3.5). The
   *  initializer expressions are evaluated with `this` bound to `dst` so that an
   *  initializer referencing `this.other` resolves correctly. Only own fields
   *  with an initializer are emitted; inherited fields are handled by the parent
   *  ctor's own super()/initializer chain. */
  emitFieldInitializers(ctx: FnCtx, classId: number, dst: number) {
    const cnode = this.classNodeOfId.get(classId);
    if (!cnode) return;
    // A dynamic/symbol-keyed member's key (and any method body) and a named field
    // initializer are lowered HERE, into the construction path. With NO explicit
    // constructor this runs inline at the `new` site (caller's scope). With an
    // explicit constructor it runs inside the ctor body — which now receives both
    // MODULE-scope captures (via published GLOBALS cells) AND FUNCTION-LOCAL
    // captures (threaded as ctor cell params; the `new`/`super` site supplies them
    // via emitCtorCall, or loud-rejects if a cell is genuinely out of scope). So
    // no capture-based reject is needed here.
    const savedThis = ctx.thisLocal;
    ctx.thisLocal = dst;
    // The initializers' `this` is the new instance, not the enclosing activation's: an arrow
    // among them (`handler = () => this.x`) captures it through a cell of its own, never the
    // enclosing function's lexical-this cell nor the cell an earlier `new` of the same block
    // made (two `new C()` in one block gave the second instance's arrows the first instance).
    const savedThisCell = ctx.cellAccess.get(this.lexicalThisSym);
    const savedBodyCell = ctx.thisCellOfBody?.get(ctx.body);
    ctx.cellAccess.delete(this.lexicalThisSym);
    ctx.thisCellOfBody?.delete(ctx.body);
    try {
      // Pre-pass: dynamic/symbol-keyed INSTANCE accessors (`get [Symbol.x]()` /
      // `set [k]()`) install as real accessor descriptors. Grouped by key-expression
      // source text so a get/set pair becomes one descriptor (installDynamicMember
      // handles one member at a time, which can't pair get+set). e.g. an instance
      // `get [Symbol.toStringTag]()` is then consulted by String(obj) for free.
      const dynAcc = new Map<string, { getter?: ts.GetAccessorDeclaration; setter?: ts.SetAccessorDeclaration; keyExpr: ts.Expression; symKey: boolean }>();
      for (const m of cnode.members) {
        if (this.isStaticMember(m) || !this.isDynComputedInstallAccessor(m)) continue;
        const keyExpr = (m.name as ts.ComputedPropertyName).expression;
        const k = keyExpr.getText();
        let a = dynAcc.get(k);
        if (a === undefined) { a = { keyExpr, symKey: this.isSymbolKeyExpr(keyExpr) }; dynAcc.set(k, a); }
        if (ts.isGetAccessorDeclaration(m)) a.getter = m; else if (ts.isSetAccessorDeclaration(m)) a.setter = m;
      }
      for (const gs of dynAcc.values()) {
        const keyLocal = this.lowerExpr(ctx, gs.keyExpr);
        const boxAcc = (d: ts.FunctionLikeDeclaration | undefined): number => {
          if (d === undefined) { const v = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: v, value: { kind: "Undef" } }); return v; }
          return this.lowerClosure(ctx, d as unknown as FnLike, "symaccessor", /*thisParam*/ true, classId);
        };
        const getterV = boxAcc(gs.getter);
        const setterV = boxAcc(gs.setter);
        const builtin = gs.symKey ? "symbol.defineAccessor:1:1:0:1" : "object.defineAccessor:1:1:0:1";
        ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin, args: [dst, keyLocal, getterV, setterV] });
      }
      for (const m of cnode.members) {
        if (this.isStaticMember(m)) continue;         // static: handled in __static_init
        if (this.isDynComputedInstallAccessor(m)) continue;  // handled in the pre-pass above
        // `declare [key]: T` / `declare x: T`: ambient, no runtime property.
        if (ts.isPropertyDeclaration(m) && ts.getModifiers(m)?.some((mod) => mod.kind === ts.SyntaxKind.DeclareKeyword)) continue;
        // dynamic/symbol-keyed computed member -> install at runtime (field, or a
        // plain/generator/async method as a data-property closure).
        if (this.isDynComputedMember(m)) {
          this.installDynamicMember(ctx, dst, m, /*thisParam*/ true, classId);
          continue;
        }
        if (!ts.isPropertyDeclaration(m)) continue;   // named methods/accessors -> vtable
        if (!m.initializer) continue;                 // declaration-only field: nothing to run
        const fname = memberKeyName(m.name);
        if (fname === undefined) continue;            // (unreachable: covered by isDynComputedMember)

        const v = this.lowerExpr(ctx, m.initializer);
        ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField(fname), src: v });
      }
    } finally {
      ctx.thisLocal = savedThis;
      if (savedThisCell !== undefined) ctx.cellAccess.set(this.lexicalThisSym, savedThisCell);
      else ctx.cellAccess.delete(this.lexicalThisSym);
      if (ctx.thisCellOfBody) {
        if (savedBodyCell !== undefined) ctx.thisCellOfBody.set(ctx.body, savedBodyCell);
        else ctx.thisCellOfBody.delete(ctx.body);
      }
    }
  }

  /** True if any of these symbols is owned by an enclosing FUNCTION scope (not
   *  module scope). Module-scope captures (owner === moduleInitNode, or no owner)
   *  are publishable to a GLOBALS[] cell and read via LoadGlobal, so they work in
   *  a constructor; a function-local capture cannot be threaded into a
   *  Direct-called constructor and must be loud-rejected. Top-level function refs
   *  are fine (boxed as capture-less closures). */
  anyFunctionLocalCapture(syms: Iterable<ts.Symbol>): boolean {
    for (const s of syms) {
      if (this.funcSymbols.has(s)) continue;
      const owner = this.symbolOwnerFunction(s);
      if (owner && owner !== (this.moduleInitNode as unknown as ts.Node)) return true;
    }
    return false;
  }

  /** Outer variable references of an expression: var-ref identifiers whose binding
   *  is NOT declared within the expression itself (so a ref to an IIFE/arrow-local
   *  is excluded). Used to classify field-initializer / computed-key captures. */
  exprOuterRefs(expr: ts.Node): Set<ts.Symbol> {
    const declaredHere = new Set<ts.Symbol>();
    const collect = (n: ts.Node) => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) {
        const s = this.symbolOf(n.name); if (s) declaredHere.add(s);
      }
      n.forEachChild(collect);
    };
    collect(expr);
    const refs = new Set<ts.Symbol>();
    const walk = (n: ts.Node) => {
      if (ts.isIdentifier(n) && this.isVarRef(n)) {
        const s = this.symbolOf(n);
        if (s && !declaredHere.has(s)) refs.add(s);
      }
      n.forEachChild(walk);
    };
    walk(expr);
    return refs;
  }

  /** Does this class member's key/initializer/body capture an enclosing-FUNCTION
   *  local? Such a member can't run inside a Direct-called constructor (the cell
   *  isn't threaded), so it is loud-rejected when the class has an explicit ctor.
   *  Module-scope captures are fine (published as module cells; see the instance
   *  field-initializer module-ref scan in run()). */
  memberCapturesFunctionLocal(m: ts.ClassElement): boolean {
    const name = (m as { name?: ts.PropertyName }).name;
    if (name && ts.isComputedPropertyName(name) && this.anyFunctionLocalCapture(this.exprOuterRefs(name.expression))) return true;
    if (ts.isPropertyDeclaration(m) && m.initializer && this.anyFunctionLocalCapture(this.exprOuterRefs(m.initializer))) return true;
    if (ts.isMethodDeclaration(m) && m.body && this.anyFunctionLocalCapture(this.freeVars(m as unknown as FnLike))) return true;
    if (ts.isConstructorDeclaration(m) && m.body && this.anyFunctionLocalCapture(this.freeVars(m as unknown as FnLike))) return true;
    return false;
  }

  /** Does constructing this class need a cell captured from an enclosing FUNCTION
   *  (a `makeClass(z)` factory's `z`)? Used to route `new K()` of a class value to
   *  the dynamic ts_construct path (which carries the cells) vs the static path. */
  classCapturesFunctionLocal(classId: number): boolean {
    const cnode = this.classNodeOfId.get(classId);
    if (!cnode) return false;
    for (const m of cnode.members) if (this.memberCapturesFunctionLocal(m)) return true;
    return false;
  }

  /** Is a class-value expression provably a SINGLE class? `const K = C` (a unique
   *  declaration whose initializer is a bare class identifier) is monomorphic, so
   *  the static result-type classId is trustworthy. `cond ? A : B` / reassignment
   *  / factory call is NOT — TS collapses these to one static type that can
   *  disagree with the runtime value. Used to gate static construction of a
   *  no-ctor class value (which has no class value to construct dynamically). */
  classValueIsMonomorphic(expr: ts.Expression): boolean {
    if (!ts.isIdentifier(expr)) return false;
    const sym = this.symbolOf(expr);
    const decls = sym?.getDeclarations?.() ?? [];
    if (decls.length !== 1) return false;
    const d = decls[0];
    if (!ts.isVariableDeclaration(d) || !d.initializer) return false;
    // const-only: a reassignable binding could hold different classes.
    const list = d.parent;
    if (!(list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const))) return false;
    let init: ts.Expression = d.initializer;
    while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isNonNullExpression(init)) init = init.expression;
    // A bare class identifier (`const K = C`) or a factory CALL (`const K = mk(z)`,
    // assumed to return a single class — a call returning a UNION is caught by the
    // union/polyClassValue check on the new-expression's result type). A
    // conditional or any other shape can yield different classes at runtime, where
    // TS collapses the static type to one member that may disagree with the value.
    if (ts.isIdentifier(init)) { const isym = this.symbolOf(init); return !!(isym && this.classSymToId.has(isym)); }
    if (ts.isCallExpression(init)) return true;
    // `const C = class { ... }`: a class expression binds exactly one class, so the
    // static result-type classId equals the runtime class (monomorphic). A
    // dynamic-base (mixin) class expression is rejected at the value site, not here.
    if (ts.isClassExpression(init)) return true;
    return false;
  }

  /** A class member whose name is a *dynamic or symbol* computed key (not a
   *  string/numeric literal, not a well-known [Symbol.iterator]-style method).
   *  Such members have no compile-time key, so they can't be vtable/layout
   *  entries; they are installed at runtime (see installDynamicMember). */
  isDynComputedMember(m: ts.ClassElement): boolean {
    const name = (m as { name?: ts.PropertyName }).name;
    if (!name || !ts.isComputedPropertyName(name)) return false;
    if (memberKeyName(name) !== undefined) return false;          // literal key -> vtable/field path
    if (this.wellKnownMethodName(m) !== undefined) return false;  // [Symbol.iterator]/[asyncIterator] -> vtable
    return true;
  }

  /** The computed-key expression of a dynamic/symbol-keyed member (the `e` in
   *  `[e]`), or undefined if `m` is not dynamically keyed. */
  dynComputedKeyExpr(m: ts.ClassElement): ts.Expression | undefined {
    if (!this.isDynComputedMember(m)) return undefined;
    const name = (m as { name?: ts.PropertyName }).name;
    if (!name || !ts.isComputedPropertyName(name)) return undefined;
    return name.expression;
  }

  /** A dynamic/symbol-keyed member whose key is `Symbol.hasInstance` — the
   *  `x instanceof C` override hook (installed on the static container under the
   *  wksym key; consulted by the instanceof lowering via classHasHasInstanceHook). */
  isDynComputedHasInstance(m: ts.ClassElement): boolean {
    const e = this.dynComputedKeyExpr(m);
    return e !== undefined && this.wellKnownSymbolId(e) === 3;
  }

  /** True if `classId` or an ancestor defines a `static [Symbol.hasInstance]`
   *  member. The hook is inherited via the proto-linked static container chain,
   *  so `x instanceof Sub` consults a base class's hook. */
  classHasHasInstanceHook(classId: number): boolean {
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const node = this.classNodeOfId.get(cur);
      if (node) for (const m of node.members)
        if (this.isStaticMember(m) && this.isDynComputedHasInstance(m)) return true;
      cur = this.parentIdOf(cur);
    }
    return false;
  }

  /** A dynamic/symbol-keyed instance get/set accessor we install at runtime as
   *  a real accessor descriptor (mirrors isDynComputedInstallMethod for methods).
   *  Static ones are lifted via setupClasses' static routing instead. */
  isDynComputedInstallAccessor(n: ts.Node): boolean {
    if (!ts.isGetAccessorDeclaration(n) && !ts.isSetAccessorDeclaration(n)) return false;
    if (!n.body) return false;
    const p = n.parent;
    if (!p || !(ts.isClassDeclaration(p) || ts.isClassExpression(p))) return false;
    if (this.isStaticMember(n)) return false;
    if (!this.isDynComputedMember(n as ts.ClassElement)) return false;
    return true;
  }

  /** A dynamic/symbol-keyed computed class METHOD we install at runtime as a
   *  data-property closure — plain, generator (`*[k]()`) and async (`async [k]()`)
   *  methods alike. The generator/async body is lowered as a state machine by
   *  lowerFunctionLike (install-path-independent) and boxed as a ts_func value
   *  identical to the proven vtable registration. Accessors with such keys take a
   *  separate path (isDynComputedInstallAccessor). */
  isDynComputedInstallMethod(n: ts.Node): boolean {
    if (!ts.isMethodDeclaration(n) || !n.body) return false;
    const p = n.parent;
    if (!p || !(ts.isClassDeclaration(p) || ts.isClassExpression(p))) return false;
    if (this.isStaticMember(n)) return false;                                       // static -> setupClasses routing
    if (!this.isDynComputedMember(n as ts.ClassElement)) return false;
    // (explicit-ctor dynamic methods are allowed when their key/body capture only
    // module-scope bindings; the function-local case is rejected at install time.)
    return true;
  }

  /** Install a dynamic/symbol-keyed computed class member onto `obj` at runtime,
   *  mirroring the object-literal computed-member lowering (exporter.ts ~861-938):
   *  a string/numeric key -> StoreFieldDynamic (runtime ToPropertyKey); a symbol
   *  key -> the `symbol.set` builtin (ts_set_symkey). A method is lifted as
   *  a closure (this bound at call); `thisParam` is true for instance members,
   *  false for statics (matching lifted static methods). Plain, generator and
   *  async methods are all installed; getters/setters with such keys are
   *  loud-rejected (they take the accessor-descriptor path instead). */
  installDynamicMember(ctx: FnCtx, obj: number, m: ts.ClassElement, thisParam: boolean, classId?: number) {
    const nameNode = (m as { name: ts.ComputedPropertyName }).name;
    const keyExpr = nameNode.expression;
    const symKey = this.isSymbolKeyExpr(keyExpr);
    // Evaluate the key first (JS evaluates a computed member key before its value).
    const keyLocal = this.lowerExpr(ctx, keyExpr);
    let v: number;
    if (ts.isPropertyDeclaration(m)) {
      if (m.initializer) v = this.lowerExpr(ctx, m.initializer);
      else { v = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: v, value: { kind: "Undef" } }); }
    } else if (ts.isMethodDeclaration(m) && m.body) {
      // Plain/generator/async method: lower its body (lowerFunctionLike emits a
      // state machine for generator/async) and box it as a ts_func closure.
      v = this.lowerClosure(ctx, m as unknown as FnLike, "dynmember", thisParam, classId);
    } else {
      // get/set accessor (or any other member) with a dynamic/symbol key
      this.unsupported(m, "class getter/setter with a dynamic or symbol computed name (only plain methods and fields supported)");
      return;
    }
    if (symKey) {
      ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "symbol.set", args: [obj, keyLocal, v] });
    } else {
      ctx.body.push({ kind: "StoreFieldDynamic", obj, key: keyLocal, src: v });
    }
  }

  /** Construct an instance of a class that has NO explicit constructor: chain to
   *  the parent constructor (passing args, like an implicit `super(...args)`),
   *  then run this class's own field initializers. Mirrors JS's synthesized
   *  default constructor. `dst` is the freshly-allocated object. */
  emitImplicitConstruction(ctx: FnCtx, classId: number, dst: number, args: number[]) {
    const parent = this.parentIdOf(classId);
    if (parent !== undefined) {
      const pctor = this.methodFunc.get(`${parent}:ctor`);
      if (pctor !== undefined) {
        const rnode = this.classNodeOfId.get(parent) ?? this.classNodeOfId.get(classId)!;
        this.emitCtorCall(ctx, pctor, dst, args, rnode);
      } else {
        // parent also has no explicit ctor: recurse into its implicit construction
        this.emitImplicitConstruction(ctx, parent, dst, args);
      }
    } else {
      // No user-class parent. If this class extends the built-in Error family, the
      // implicit `super(message)` sets `this.message` (Error's observable effect).
      if (this.extendsBuiltinError(classId) && args.length > 0) {
        this.defineDataField(ctx, dst, "message", args[0], 0, 1, 1); // own, non-enumerable
      }
      for (const a of args) void a;
    }
    this.emitFieldInitializers(ctx, classId, dst);
  }

  /** How the SHARED (arg-count-agnostic) class-value ctor of a no-ctor class handles
   *  constructor args passed via a polymorphic `new K(...args)`:
   *    "ignore"  — no explicit-ctor ancestor: the implicit ctor drops args (JS semantics).
   *    "forward" — reaches an explicit-ctor parent: args are forwarded as `super(...rest)`
   *                (emitImplicitConstructionForward), threading the parent ctor's capture
   *                cells (rolled up into this synth ctor's env by synthCtorFreeVars).
   *  Walks the no-ctor chain exactly like emitImplicitConstruction's recursion. */
  noCtorForwardKind(classId: number): "ignore" | "forward" {
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const parent = this.parentIdOf(cur);
      if (parent === undefined) return "ignore"; // no parent ctor anywhere -> args dropped
      if (this.methodFunc.has(`${parent}:ctor`)) return "forward";
      cur = parent; // parent is also no-ctor: keep walking
    }
    return "ignore";
  }

  /** Like emitImplicitConstruction but forwards a REST-array local (the synth ctor's
   *  `...args`) to the first explicit-ctor parent as `super(...rest)`, then runs each
   *  no-ctor class's field initializers. Used when noCtorForwardKind === "forward".
   *  The parent ctor's ABI is `[cells..., this, ...realargs]` (emitCtorCall's cells
   *  form): we reproduce it with a recv-less CallSpread whose argSpecs are the parent's
   *  capture cells (resolved from this synth ctor's env via ctorCellArgs — present
   *  because synthCtorFreeVars rolled them up), then `this`, then `...rest`. With no
   *  captures this is `[this, ...rest]`. */
  emitImplicitConstructionForward(ctx: FnCtx, classId: number, dst: number, restLid: number) {
    const parent = this.parentIdOf(classId);
    if (parent !== undefined) {
      const pctor = this.methodFunc.get(`${parent}:ctor`);
      if (pctor !== undefined) {
        const cells = this.ctorCellArgs(ctx, pctor);
        if (cells === null) {
          // Defensive: synthCtorFreeVars should have supplied every parent-ctor cell.
          const rnode = this.classNodeOfId.get(parent) ?? this.classNodeOfId.get(classId)!;
          this.unsupported(rnode, "polymorphic new forwarding args to a parent constructor whose captured local is not in scope");
          return;
        }
        const argSpecs: { kind: string; local: number }[] = [
          ...cells.map((c) => ({ kind: "single", local: c })),
          { kind: "single", local: dst },
          { kind: "spread", local: restLid },
        ];
        ctx.body.push({ kind: "CallSpread", argSpecs, callee: { kind: "Direct", func: pctor } });
      } else {
        this.emitImplicitConstructionForward(ctx, parent, dst, restLid);
      }
    }
    this.emitFieldInitializers(ctx, classId, dst);
  }

  /** Synthesize a class-value constructor for a class WITHOUT an explicit ctor, so
   *  `const K = C` becomes a proper ts_func class value (not a static-container
   *  object / undefined). The body runs the same implicit construction (field inits
   *  + parent chain) as a static `new C()`, with `this` = args[0]. Memoized per
   *  class. Returns undefined when synthesis is impossible — a field initializer
   *  captures an enclosing function local, which a top-level synthetic function
   *  can't see (the caller then falls back to the container representation).
   *  NOT registered in `methodFunc`, so static `new C()` / super / implicit
   *  construction paths are unchanged; this only supplies the class value's code. */
  synthClassValueCtor(classId: number): number | undefined {
    const memo = this.synthCtorMemo.get(classId);
    if (memo !== undefined) return memo < 0 ? undefined : memo;
    // "forward" (an explicit-ctor ancestor exists) -> the synth ctor takes a rest param
    // and forwards it as `super(...args)`; "ignore" -> args are dropped (no such ancestor).
    const fwd = this.noCtorForwardKind(classId);
    const fnId = this.allocSpecFn();
    this.synthCtorMemo.set(classId, fnId);
    const name = `__class_ctor_${classId}`;
    const ctx: FnCtx = {
      id: fnId, name, params: [], locals: [], body: [],
      localOfSymbol: new Map(), cellAccess: new Map(),
      isExported: false, hoistedFns: new Set(),
    };
    // A no-ctor class can capture enclosing function locals in its field initializers
    // (`class A { a = x }`). Thread those captures as leading cell params — the same
    // env layout the value-creation site supplies via synthClassValueCaptures (both
    // use synthCtorFreeVars -> bindingId order, so they agree). The field-init
    // lowering reads each `x` through ctx.cellAccess. Mirrors lowerFunctionLike's
    // emitCells ([cells..., this]) and an explicit ctor's classValueCaptures.
    const frees = this.synthCtorFreeVars(classId);
    const captureSlots = this.captureSlots(frees);
    for (const slot of captureSlots) this.bindCaptureParam(ctx, slot);
    const tid = this.newLocal(ctx, "reference", "this");
    ctx.params.push(tid);          // arg0 = this (the freshly allocated instance)
    ctx.thisLocal = tid;
    ctx.currentClass = classId;
    let restLid: number | null = null;
    if (fwd === "forward") {
      // Implicit `constructor(...args){ super(...args) }`: take a rest param after
      // `this` and forward it to the first explicit-ctor ancestor. Handles both
      // zero-arg (`super()`) and `new K(x)` (`super(x)`) uniformly.
      restLid = this.newLocal(ctx, "reference", "args");
      ctx.params.push(restLid);
      ctx.restParam = restLid;
      this.emitImplicitConstructionForward(ctx, classId, tid, restLid);
    } else {
      // "ignore": no explicit-ctor ancestor, args are dropped (JS semantics).
      // "reject": no value-with-args path needs the forward; build the no-arg form
      // (the args>0 poly new is rejected at the gate via noCtorForwardKind).
      this.emitImplicitConstruction(ctx, classId, tid, []);
    }
    this.noteFnModule(fnId);
    this.functions.push({
      id: fnId, name, params: ctx.params, ret: 0, locals: ctx.locals, body: ctx.body,
      isExported: false, paramClasses: ctx.paramClasses || {}, restParam: restLid,
      isAsync: false, isGenerator: false, takesThis: true, captureCount: captureSlots.length, arity: 0,
    });
    return fnId;
  }

  /** Function-local bindings captured by a no-ctor class's implicit construction:
   *  the instance field initializers + dynamic/symbol computed-member keys/bodies of
   *  the class AND its no-ctor ancestors (emitImplicitConstruction recurses into the
   *  no-ctor parent chain, stopping at the first explicit-ctor parent — whose own
   *  captures travel through its ctor). Mirrors freeVars' ctor field-init scan
   *  (801-812), filtered to function-local owners (module-scope reads go via GLOBALS)
   *  and sorted by bindingId so the synth ctor prologue and the value-site capture
   *  list agree on env order. */
  synthCtorFreeVars(classId: number): ts.Symbol[] {
    const res = new Set<ts.Symbol>();
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const cnode = this.classNodeOfId.get(cur);
      if (cnode) {
        for (const m of cnode.members) {
          if (this.isStaticMember(m)) continue;
          const nm = (m as { name?: ts.PropertyName }).name;
          if (nm && ts.isComputedPropertyName(nm) && this.isDynComputedMember(m))
            for (const s of this.exprOuterRefs(nm.expression)) res.add(s);
          if (ts.isPropertyDeclaration(m) && m.initializer)
            for (const s of this.exprOuterRefs(m.initializer)) res.add(s);
          if (this.isDynComputedInstallMethod(m) || this.isDynComputedInstallAccessor(m))
            for (const s of this.freeVars(m as unknown as FnLike)) res.add(s);
        }
      }
      const parent: number | undefined = this.parentIdOf(cur);
      if (parent === undefined) break;
      if (this.methodFunc.has(`${parent}:ctor`)) {
        // The chain stops at an explicit-ctor parent: emitImplicitConstructionForward
        // calls that ctor as `super(...rest)` and must thread its function-local
        // capture cells (ctorCellArgs). Roll up the parent ctor's free vars so they
        // become cell params of this synth ctor too (and capture-list entries at the
        // value site). freeVars is transitive, covering the parent's own super chain.
        const pnode = this.ctorNodeOfClassId(parent);
        if (pnode) for (const s of this.freeVars(pnode as unknown as FnLike)) res.add(s);
        break;
      }
      cur = parent;
    }
    const arr = [...res].filter((s) => {
      if (this.funcSymbols.has(s)) return false;
      const owner = this.symbolOwnerFunction(s);
      return !!(owner && owner !== (this.moduleInitNode as unknown as ts.Node));
    });
    for (const s of arr) this.bindingIdOf(s);
    arr.sort((a, b) => this.bindingIdOf(a) - this.bindingIdOf(b));
    return arr;
  }

  /** The capture list (binding id + cell local) for a no-ctor class value, resolved
   *  from the value-creation site's cellAccess. Order matches synthClassValueCtor's
   *  cell-param prologue (both use synthCtorFreeVars). Returns null if a required
   *  cell isn't held here (genuinely cross-scope) — caller falls back / loud-rejects
   *  rather than threading a garbage cell. Mirrors classValueCaptures for synth. */
  synthClassValueCaptures(ctx: FnCtx, classId: number): { binding: number; cell: number }[] | null {
    const out: { binding: number; cell: number }[] = [];
    for (const slot of this.captureSlots(this.synthCtorFreeVars(classId))) {
      const cell = this.heldSlot(ctx, slot);
      if (cell === undefined) return null;
      out.push({ binding: slot.binding, cell });
    }
    return out;
  }

  /** Lower `new <Builtin>(...)` for the supported built-in constructors
   *  (Map/Set/WeakMap/WeakSet/Headers/Array/Date/Error family/Promise). Returns the result local, or
   *  undefined when `ctorName` is not a supported built-in (caller continues to
   *  the user-class / class-value paths). Built-in-specific rejects (Date
   *  string/Date arg, Promise without an executor) live here. */
  lowerNewBuiltin(ctx: FnCtx, node: ts.NewExpression, ctorName: string, hint?: string): number | undefined {
    // Typed arrays and buffers (docs/typed_arrays_design.md): the runtime
    // constructor takes every argument (a length, an array-like or iterable, or
    // a buffer with an optional offset and length).
    const taElem = TYPED_ARRAY_ELEMS.get(ctorName);
    if (taElem !== undefined || ctorName === "ArrayBuffer" || ctorName === "SharedArrayBuffer") {
      const argNodes = node.arguments ?? [];
      if (argNodes.some((a) => ts.isSpreadElement(a))) {
        this.unsupported(node, `new ${ctorName}(...spread)`);
        return this.newLocal(ctx, "reference", hint);
      }
      // A second ArrayBuffer argument makes a resizable buffer, which is not modeled.
      if (taElem === undefined && argNodes.length > 1) {
        this.unsupported(node, `resizable ${ctorName} (an options argument)`);
        return this.newLocal(ctx, "reference", hint);
      }
      const args = this.lowerSequenced(ctx, argNodes);
      const dst = this.newLocal(ctx, "reference", hint);
      const builtin = taElem !== undefined ? `typedarray.new:${taElem}` : `arraybuffer.new:${ctorName === "ArrayBuffer" ? 0 : 1}`;
      ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin, args });
      return dst;
    }
    // TextEncoder / TextDecoder (docs/text_codecs_design.md): every argument is
    // evaluated; the decoder takes its label and options.
    if (ctorName === "TextEncoder" || ctorName === "TextDecoder") {
      const argNodes = node.arguments ?? [];
      if (argNodes.some((a) => ts.isSpreadElement(a))) {
        this.unsupported(node, `new ${ctorName}(...spread)`);
        return this.newLocal(ctx, "reference", hint);
      }
      const args = this.lowerSequenced(ctx, argNodes);
      const dst = this.newLocal(ctx, "reference", hint);
      ctx.body.push({ kind: "CallBuiltinStatic", dst,
        builtin: ctorName === "TextEncoder" ? "textencoder.new" : "textdecoder.new",
        args: ctorName === "TextEncoder" ? [] : args.slice(0, 2) });
      return dst;
    }
    if (ctorName === "RegExp") {
      return this.lowerRegExpConstructor(ctx, node, hint);
    }
    // Map/Set and their weak counterparts lower to runtime containers.
    // Constructor-arg seeding is materialized by the matching *.seed helper.
    if (ctorName === "Map" || ctorName === "Set" ||
        ctorName === "WeakMap" || ctorName === "WeakSet") {
      const dst = this.newLocal(ctx, "reference");
      if (ctorName === "Map") ctx.body.push({ kind: "NewMap", dst });
      else if (ctorName === "Set") ctx.body.push({ kind: "NewSet", dst });
      else ctx.body.push({ kind: "CallBuiltinStatic", dst,
        builtin: ctorName === "WeakMap" ? "weakmap.new" : "weakset.new", args: [] });
      // Constructor-arg seeding: new Set(iterable) adds each element; new
      // Map(iterable) treats each element as a [key, value] pair. The iterable
      // is materialized to an array (spread handles array/generator/set/map),
      // then a runtime helper fills the container.
      if (node.arguments && node.arguments.length > 0 &&
          node.arguments[0].kind !== ts.SyntaxKind.UndefinedKeyword) {
        const arg = this.lowerExpr(ctx, node.arguments[0]);
        ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
          builtin: ctorName === "Map" ? "map.seed" :
                   ctorName === "Set" ? "set.seed" :
                   ctorName === "WeakMap" ? "weakmap.seed" : "weakset.seed",
          args: [dst, arg] });
      }
      return dst;
    }
    if (ctorName === "AbortController") {
      const dst = this.newLocal(ctx, "reference");
      const argLs = this.lowerSequenced(ctx, node.arguments ? Array.from(node.arguments) : []);
      ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "abortcontroller.new", args: argLs });
      return dst;
    }
    // new Proxy(target, handler) -> a runtime proxy that intercepts every
    // property/call/construct operation and dispatches to handler traps.
    if (ctorName === "Proxy") {
      const args = node.arguments ?? [];
      if (args.length < 2) {
        this.unsupported(node, "new Proxy requires a target and a handler argument");
        return this.newLocal(ctx, "reference");
      }
      const target = this.lowerExpr(ctx, args[0]);
      const handler = this.lowerExpr(ctx, args[1]);
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "proxy.new", args: [target, handler] });
      return dst;
    }
    // new Array(...) -> a runtime array (length form for a single numeric arg,
    // else element list). Shared with the bare Array(...) call form.
    if (ctorName === "Array") {
      return this.lowerArrayConstruct(ctx, node.arguments ? Array.from(node.arguments) : [], node, hint);
    }
    // new Date() -> a plain object carrying epoch-ms at the reserved date field.
    // Only the no-arg form (current time) is supported; arg forms rejected.
    if (ctorName === "Date") {
      const args = node.arguments ?? [];
      const dst = this.newLocal(ctx, "reference");
      const site = this.site++;
      this.recordSite(site, "object", "once", true, node);
      ctx.body.push({ kind: "AllocObject", dst, typeId: 0, site });
      const ms = this.newLocal(ctx, "primitive");
      const numConst = (val: number): number => {
        const l = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst: l, value: { kind: "Num", value: this.numWire(val) } });
        return l;
      };
      if (args.length === 0) {
        // current time.
        ctx.body.push({ kind: "CallBuiltinStatic", dst: ms, builtin: "date.now", args: [] });
      } else if (args.length === 1) {
        // new Date(epochMs): numeric only. String/Date arguments need date
        // parsing, which is not implemented (loud-reject rather than NaN).
        let isNumeric = false;
        try {
          const t = this.checker.getTypeAtLocation(args[0]);
          isNumeric = (t.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0;
        } catch { /* leave isNumeric false */ }
        const v = this.lowerExpr(ctx, args[0]);
        if (isNumeric) ctx.body.push({ kind: "Copy", dst: ms, src: v });
        else ctx.body.push({ kind: "CallBuiltinStatic", dst: ms, builtin: "date.value_ms", args: [v] });   // a Date's time, a string parsed, else ToNumber
      } else {
        // new Date(year, month, day=1, hours=0, minutes=0, seconds=0, ms=0) — local time.
        const a = args.map((x) => this.lowerExpr(ctx, x));
        const comp = [
          a[0], a[1],
          a[2] ?? numConst(1),
          a[3] ?? numConst(0), a[4] ?? numConst(0), a[5] ?? numConst(0), a[6] ?? numConst(0),
        ];
        ctx.body.push({ kind: "CallBuiltinStatic", dst: ms, builtin: "date.fromComponents", args: comp });
      }
      ctx.body.push({ kind: "StoreField", obj: dst, field: this.DATE_MS_FIELD, src: ms });
      return dst;
    }
    // new Error(msg) / new TypeError(msg) / ... -> a plain object whose
    // `message` field holds the message (and `name` the error kind). This
    // mirrors the observable surface of the builtin Error constructor; our
    // runtime has no distinct Error type, so a tagged object suffices for
    // try/catch + e.message / e.name access.
    {
      const errIdx = this.errorKindIndex(ctorName);
      if (errIdx !== undefined) {
        // Construct via the runtime so the instance is proto-linked to the shared
        // Error-family prototype (instanceof Error works; `name` is inherited).
        const dst = this.newLocal(ctx, "reference");
        const args = node.arguments && node.arguments.length > 0 ? [this.lowerExpr(ctx, node.arguments[0])] : [];
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: `error.new:${errIdx}`, args });
        return dst;
      }
    }
    // new Promise((resolve, reject) => {...}) -> a runtime promise. The executor
    // is lowered to a closure value; the runtime (ts_promise_new_executor) builds
    // resolve/reject bound to the new promise and calls the executor synchronously
    // (a throwing executor rejects).
    if (ctorName === "Promise") {
      const ex = node.arguments && node.arguments[0];
      if (!ex) { this.unsupported(node, "new Promise requires an executor function argument"); return this.newLocal(ctx, "reference"); }
      const exL = this.lowerExpr(ctx, ex);
      const dst = this.newLocal(ctx, "reference", hint);
      ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "promise.new", args: [exL] });
      return dst;
    }
    return undefined;  // not a supported built-in -> user class / class value
  }

  /** Classify a `new <identifier>(...)` whose callee is NOT a supported built-in
   *  (those are handled by lowerNewBuiltin first) and is NOT a polymorphic class
   *  value (handled by the lowerPolymorphicNew pre-pass). Resolves the target class
   *  id and performs the same side effects as the old inline path, in the same
   *  order: name-collision fallback, result-type class-value resolution, generic
   *  specialization (specializedClassId / resolveSpecializedParent), and RTA
   *  field-type recording (recordInstantiationFieldTypes). Returns a NewTarget for
   *  the caller to dispatch on; emits no IR. */
  resolveNewTarget(node: ts.NewExpression): NewTarget {
    const csym = this.symbolOf(node.expression);
    let classId = csym ? this.classSymToId.get(csym) : undefined;
    // Name-collision fallback: a user `class Node {}` whose name collides with
    // an ambient global (lib.dom's `Node`) may resolve `csym` to the merged
    // symbol that isn't the map key. If unresolved and the constructor
    // identifier's name matches a known user class, use that class id (the
    // user class shadows the ambient global value).
    if (classId === undefined && ts.isIdentifier(node.expression)) {
      const nm = node.expression.text;
      for (const [cid, cnode] of this.classNodeOfId) {
        if (cnode.name && cnode.name.text === nm) { classId = cid; break; }
      }
    }
    // Phase B: `new K()` where K is a variable holding a class VALUE — its symbol
    // is the binding, not the class declaration, so the lookups above miss. But
    // the new-expression's RESULT type IS the instance type C, so resolve the
    // classId from there. Lets `const K = C; new K()` construct C statically
    // (same as `new C()`); the captured-cell case routes to Phase A below.
    let classIdFromValue = false;
    let polyClassValue = false; // union of class values (cond ? C : D)
    if (classId === undefined) {
      try {
        const it = this.checker.getTypeAtLocation(node);
        if (it.isUnion && it.isUnion()) {
          // Polymorphic class value: the static result type can't pick ONE class
          // (it's a union of instance types), so we must NOT resolve a single
          // classId here (that would silently construct an arbitrary member). The
          // lowerPolymorphicNew pre-pass handles/rejects this before we get here.
          const members = (it as ts.UnionType).types;
          if (members.length > 0 && members.every((m) => { const s = m.getSymbol && m.getSymbol(); return !!(s && this.classSymToId.has(s)); })) {
            polyClassValue = true;
          }
        } else {
          const isym = (it.getSymbol && it.getSymbol()) || undefined;
          if (isym) classId = this.classSymToId.get(isym);
          if (classId !== undefined) classIdFromValue = true;
        }
      } catch { /* not resolvable -> reject below / non-class reject in helper */ }
    }
    // Dead defensive arm: the polymorphic-new pre-pass (lowerPolymorphicNew) runs
    // for ALL new-expressions before the identifier gate, and always returns a
    // result (or its own reject placeholder) when this union with all-resolvable
    // members holds — so we never reach here with polyClassValue. Reject rather
    // than miscompile if that invariant ever breaks.
    if (polyClassValue) {
      return { kind: "reject", reason: `new K() where K is a polymorphic class value (cond ? C : D); only a monomorphic class value (const K = C, or a single-class factory) is supported` };
    }
    // Full generic class cloning: new Box<number>() -> dedicated Box$number class
    // (distinct id, cloned ctor/methods under T->concrete). Distinct type args
    // become distinct classes. Falls back to the original id otherwise.
    if (classId !== undefined) {
      try {
        const it = this.checker.getTypeAtLocation(node);
        const spec = this.specializedClassId(it, node);
        if (spec !== undefined) classId = spec;
      } catch { /* keep original id */ }
      // Generic inheritance: if this class extends Base<number>, specialize the
      // parent so inherited fields/methods are concretely typed.
      this.resolveSpecializedParent(classId);
    }
    // Monomorphization (RTA): record the resolved concrete field types for this
    // instantiation, so a uniformly-instantiated generic class can specialize its
    // field representation (e.g. Box<number>.value -> unboxed double).
    if (classId !== undefined) this.recordInstantiationFieldTypes(classId, node);
    // Phase A: classId came from the result type (K is a class VALUE).
    if (classIdFromValue && classId !== undefined) {
      // Only a MONOMORPHIC class value is sound: the static result-type classId
      // must equal the runtime class (so construction AND downstream method/field
      // devirtualization agree). TS collapses a polymorphic `cond ? B : A` to one
      // member, so reject non-monomorphic class values rather than miscompiling.
      if (!this.classValueIsMonomorphic(node.expression)) {
        return { kind: "reject", reason: `new K() where K is a non-monomorphic class value (polymorphic / reassigned); only const K = C or a single-class factory is supported` };
      }
      // Explicit ctor: construct DYNAMICALLY through K (which carries any captured
      // cells for a factory) via ts_construct (NewDynamic).
      if (this.methodFunc.get(`${classId}:ctor`) !== undefined) {
        return { kind: "valueDynamic", classId };
      }
      // No explicit ctor that captures a function local: construct DYNAMICALLY through
      // the class value K, whose synthesized ctor carries the captured cells on its env
      // (resolved at the `const K = C` value site via synthClassValueCaptures). The
      // static result-type classId equals the runtime class (monomorphic), so
      // downstream devirtualization still agrees.
      if (this.classCapturesFunctionLocal(classId)) {
        return { kind: "valueDynamic", classId };
      }
      // else (no captures): fall through to static construction (emitImplicitConstruction).
    }
    // ES5 function constructor (`new Foo()` where Foo is a plain FUNCTION, not a
    // class): ride the existing NewDynamic -> ts_construct path, whose class_id==0
    // arm implements a plain function's [[Construct]]. The infra is already in
    // place: function declarations/expressions get an own .prototype at boxing
    // (FN_HAS_PROTOTYPE -> ts_set_fn_prototype, which also marks constructable),
    // and module-scope declarations are boxed ONCE into a singleton global
    // (functionValueGlobal), so `Foo.prototype.m = ...` and `new Foo()` see the
    // same prototype object. Matches a top-level function declaration
    // (funcSymbols) or any non-ambient binding whose type is callable
    // (`const F = function(){...}`, nested declarations, params). Non-constructable
    // values that slip through (arrows/methods/async/generators) throw V8's
    // catchable TypeError in ts_construct — never a silent construct. Ambient
    // builtins (`new isNaN()`) keep the loud reject below.
    // A constructor the Node prelude provides (URL, URLSearchParams): the identifier
    // is lib.dom's ambient declaration, the value is the prelude's class on the
    // global object, and the instance is constructed through it (ts_construct).
    if (classId === undefined && nodePreludeFile !== undefined && ts.isIdentifier(node.expression) &&
        (NODE_PRELUDE_CTORS.has(node.expression.text) || node.expression.text === "String") && this.isAmbientGlobalSymbol(csym)) {
      return { kind: "functionValue" };
    }
    if (classId === undefined && !this.isAmbientGlobalSymbol(csym)) {
      let callable = csym !== undefined && this.funcSymbols.has(csym);
      if (!callable) {
        try {
          callable = this.checker.getTypeAtLocation(node.expression).getCallSignatures().length > 0;
        } catch { /* not callable -> fall through to the loud reject */ }
      }
      if (callable) return { kind: "functionValue" };
    }
    return { kind: "staticClass", classId };
  }

  /** Construct a statically-known class in place: allocate the class-tagged object,
   *  then run its explicit constructor (capturing the ctor's return for classes
   *  flagged constructor-returns-value) or its implicit construction (field inits +
   *  parent chain). When `classId` is undefined the identifier is neither a known
   *  class nor a supported built-in -> loud-reject (after still lowering args for
   *  their side effects, matching the original). Only called for identifier callees
   *  (resolveNewTarget's staticClass kind). */
  lowerNewStaticClass(ctx: FnCtx, node: ts.NewExpression, classId: number | undefined, hint?: string): number {
    const calleeName = ts.isIdentifier(node.expression) ? node.expression.text : "(expr)";
    const site = this.site++;
    const dst = this.newLocal(ctx, "reference", hint);
    this.labels[site] = `new ${calleeName}@${ctx.name}`;
    this.recordSite(site, "object", this.inLoop(node) ? "many" : "once", classId !== undefined, node);
    const inst: any = { kind: "AllocObject", dst, typeId: 0, site };
    if (classId !== undefined) {
      const klass = this.lowerExpr(ctx, node.expression);
      inst.classId = classId;
      // a shared prototype is the registered one: the emitter sets CLASS_PROTO
      if (!this.sharedClassProto(classId)) inst.proto = this.loadClassValuePrototype(ctx, klass);
      else this.checkClassBindingInitialized(ctx, node.expression, klass);
    }
    ctx.body.push(inst);
    // constructor call: Direct to C's ctor, recv = the new object. Field
    // initializers (§3.5) run INSIDE the ctor (after super), so they are emitted
    // in the ctor body (see lowerFunctionLike 3b). When a class has field
    // initializers but no explicit ctor, a synthetic ctor is created so they run.
    const cfunc = classId !== undefined ? this.methodFunc.get(`${classId}:ctor`) : undefined;
    const args = this.lowerSequenced(ctx, node.arguments ?? []);
    // new operator step 4 (ECMA-262 11.2.2 / 13.2.2, see unified_object_model
    // §10): if the constructor RETURNS AN OBJECT, `new C()` evaluates to that
    // object, not the freshly-allocated instance. We only take the extra step
    // for classes the analyzer flagged `constructor-returns-value` (others can
    // never return a value, so they keep the fast path: the instance IS the
    // result). For such classes we capture the ctor's return and let the runtime
    // pick: object return -> use it; primitive/undefined -> use the instance.
    const ctorReturns = classId !== undefined &&
      (this.classInfos[classId]?.reasons.includes("constructor-returns-value") ?? false);
    if (cfunc !== undefined) {
      if (ctorReturns) {
        const ret = this.newLocal(ctx, "reference");
        this.emitCtorCall(ctx, cfunc, dst, args, node, ret);
        const res = this.newLocal(ctx, "reference", hint);
        ctx.body.push({ kind: "ConstructResult", dst: res, inst: dst, ret });
        return res;
      }
      this.emitCtorCall(ctx, cfunc, dst, args, node);
    } else if (classId !== undefined) {
      // no explicit ctor: run field initializers (and chain to parent ctor)
      // directly on the new object, since there is no ctor body to host them.
      this.emitImplicitConstruction(ctx, classId, dst, args);
    } else if (calleeName === "Function" && ts.isIdentifier(node.expression) && this.isAmbientGlobalSymbol(this.symbolOf(node.expression))) {
      // `new Function(src)`: code generation from a string, which a compiled program has no engine
      // for. A catchable EvalError at the site (V8 under a Content Security Policy throws the same), so
      // a program whose dynamic path is never taken (a dev-only validator, an eval fallback) compiles.
      ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), args: [],
        builtin: "throw.eval:Code generation from strings is not available in a compiled program (new Function)" });
    } else if (ts.isIdentifier(node.expression) && this.isAmbientGlobalSymbol(this.symbolOf(node.expression))) {
      // A constructor the environment declares (lib.dom's ReadableStream, CustomEvent, WebSocket) that
      // the runtime does not provide: the construct goes through the global object at run time, a
      // ReferenceError where it is reached (as Node throws for a global it lacks), so a program whose
      // such path is never taken (hono's streaming renderer, its WebSocket client) compiles. A class
      // value held in a variable stays a compile-time reject below (its environment is not a value).
      const g = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadBuiltinFn", dst: g, builtin: "globalThis" });
      const callee = this.newLocal(ctx, "reference", calleeName);
      ctx.body.push({ kind: "LoadField", dst: callee, obj: g, field: this.internField(calleeName) });
      ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: `binding.check:${calleeName}`, args: [callee] });
      this.emitNewMaybeGuarded(ctx, node, dst, callee, args);
    } else {
      // `new X()` where X is an identifier that does NOT resolve to a known user
      // class and is not a supported built-in (Array/Map/Set/Date/Error...). The
      // common cases are a class VALUE held in a variable (`const K = C; new K()`
      // — a class can't carry a captured environment as a runtime value here) and
      // an unsupported built-in constructor (`new Promise(...)`, `new RegExp(...)`,
      // ...). Previously this silently produced an empty object (ctor + field
      // initializers skipped). Loud-reject instead of miscompiling.
      for (const a of args) void a;
      this.unsupported(node, `new ${calleeName}(...) where ${calleeName} is not a statically-known class or a supported built-in (instantiating a class value held in a variable, or an unsupported built-in constructor, is not supported)`);
    }
    return dst;
  }

  /** `new <expr>()` where the static result type is a UNION of known classes (a
   *  polymorphic class value, e.g. `const K = cond ? A : B; new K()`). Returns the
   *  result local, or undefined if `node` isn't such a polymorphic new (caller
   *  continues with the normal monomorphic paths). Constructs dynamically via the
   *  runtime value's class_id (NewDynamic -> ts_construct); the union result type
   *  has no single symbol, so downstream field/method access uses the dynamic path
   *  (ts_get field-descriptor table + proto-chain dispatch) — correct for whichever
   *  member the value actually is. Loud-rejects (returning a placeholder) when a
   *  member isn't constructible-as-value or args can't be forwarded. */
  lowerPolymorphicNew(ctx: FnCtx, node: ts.NewExpression, hint?: string): number | undefined {
    let it: ts.Type | undefined;
    try { it = this.checker.getTypeAtLocation(node); } catch { it = undefined; }
    let memberCids: (number | undefined)[] | undefined;
    let poly = false; // taint the result for downstream dynamic dispatch (see below)
    if (it && it.isUnion && it.isUnion()) {
      // Distinct-shape / common-base union: TS keeps it a union, so the result has no
      // single static class — downstream field/method access is ALREADY dynamic
      // (classOfExpr returns undefined for a union). No taint needed.
      memberCids = (it as ts.UnionType).types.map((m) => {
        const s = m.getSymbol && m.getSymbol();
        return s ? this.classSymToId.get(s) : undefined;
      });
      if (memberCids.length === 0 || !memberCids.every((cid) => cid !== undefined)) return undefined;
    } else {
      // STRUCTURALLY-IDENTICAL members: TS collapses `A | B` to one static type, so
      // the result would be devirtualized as that single class — unsound when the
      // runtime object is the other member (their methods may differ; their field
      // LAYOUTS are identical, so field access is fine). Recover the candidate set by
      // value-flow on the callee (`cond ? A : B`), construct dynamically, and mark the
      // result `poly` so devirt taints it and forces dynamic method dispatch.
      const cands = this.collectClassValueCandidates(node.expression);
      if (cands === undefined || cands.length < 2) return undefined;
      memberCids = cands;
      poly = true;
    }
    const args = node.arguments ?? [];
    // Every member is constructible with whatever args are passed: an explicit-ctor
    // member handles its own args; a no-ctor member's synthesized class-value ctor
    // (synthClassValueCtor) runs field inits + the parent chain, dropping args when
    // there's no explicit-ctor ancestor or forwarding them as `super(...args)`
    // otherwise (emitImplicitConstructionForward — threading the parent's capture cells
    // too). Function-local captures (field inits and/or the parent ctor) ride on the
    // class value's env, resolved when the member's class value is built at
    // lowerExpr(callee); a genuinely cross-scope capture there falls back to the
    // container form, where `new` then fails loudly (never silently miscompiles).
    const callee = this.lowerExpr(ctx, node.expression);
    const dargs = this.lowerSequenced(ctx, args);
    const ddst = this.newLocal(ctx, "reference", hint);
    ctx.body.push({ kind: "NewDynamic", dst: ddst, callee, args: dargs, poly });
    return ddst;
  }

  /** Recover the runtime class candidates of a class-value expression by VALUE-FLOW
   *  (not the static type, which collapses structurally-identical members). Descends
   *  through parens / `as` / `!`, conditional (`a ? b : c`) and `||` / `??` operators,
   *  and a one-step deref of a `const K = <those>` binding. Returns the distinct class
   *  ids if EVERY leaf resolves to a known class identifier, else undefined (so the
   *  caller treats it as a non-polymorphic / unsupported new). */
  collectClassValueCandidates(expr: ts.Expression): number[] | undefined {
    const seen = new Set<number>();
    const out: number[] = [];
    const visiting = new Set<ts.Symbol>(); // guard against cyclic const derefs
    const add = (cid: number) => { if (!seen.has(cid)) { seen.add(cid); out.push(cid); } };
    const walk = (e: ts.Expression): boolean => {
      while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
      if (ts.isConditionalExpression(e)) return walk(e.whenTrue) && walk(e.whenFalse);
      if (ts.isBinaryExpression(e) &&
          (e.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
           e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
        return walk(e.left) && walk(e.right);
      }
      if (ts.isIdentifier(e)) {
        const sym = this.symbolOf(e);
        const cid = sym ? this.classSymToId.get(sym) : undefined;
        if (cid !== undefined) { add(cid); return true; }
        // deref a `const K = <conditional over classes>` binding (transitively)
        if (sym && !visiting.has(sym)) {
          const decls = sym.getDeclarations?.() ?? [];
          if (decls.length === 1 && ts.isVariableDeclaration(decls[0]) && decls[0].initializer) {
            const list = decls[0].parent;
            if (list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const)) {
              visiting.add(sym);
              const ok = walk(decls[0].initializer);
              visiting.delete(sym);
              return ok;
            }
          }
        }
        return false;
      }
      return false;
    };
    return walk(expr) && out.length > 0 ? out : undefined;
  }

  /** A `new <expr>()` whose result is a COLLAPSED polymorphic class value — the
   *  members are structurally identical so TS reports one static type, but the
   *  runtime class is one of several (see lowerPolymorphicNew's collapse branch).
   *  Such a value's static class is untrustworthy for identity (instanceof) and
   *  method dispatch. Distinct-shape unions (TS keeps them a union) are NOT collapsed
   *  and are excluded here — their downstream access is already dynamic. */
  isCollapsedPolyNew(node: ts.NewExpression): boolean {
    let it: ts.Type | undefined;
    try { it = this.checker.getTypeAtLocation(node); } catch { it = undefined; }
    if (it && it.isUnion && it.isUnion()) return false;
    const cands = this.collectClassValueCandidates(node.expression);
    return cands !== undefined && cands.length >= 2;
  }

  /** Does this function's OWN body construct a collapsed polymorphic class value?
   *  (Cached.) When true, a method/instanceof on a local-typed value in this function
   *  may be a polymorphic instance, so the instanceof staticallyTrue shortcut is
   *  suppressed (the runtime proto-walk is always correct). Functions without such a
   *  `new` — the overwhelming majority — keep the shortcut, so there's no perf impact
   *  there. (Nested functions are separate FnLikes with their own flag.) */
  _fnHasPolyNew = new Map<ts.Node, boolean>();
  fnHasCollapsedPolyNew(fn: ts.Node): boolean {
    const memo = this._fnHasPolyNew.get(fn);
    if (memo !== undefined) return memo;
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if (n !== fn && isFunctionLike(n)) return; // don't descend into nested functions
      if (ts.isNewExpression(n) && this.isCollapsedPolyNew(n)) { found = true; return; }
      n.forEachChild(walk);
    };
    const body = (fn as { body?: ts.Node }).body;
    if (body) walk(body);
    this._fnHasPolyNew.set(fn, found);
    return found;
  }

  /** Could this expression's value be a COLLAPSED polymorphic class instance (whose
   *  static class is untrustworthy)? Used to suppress the instanceof staticallyTrue
   *  shortcut. Precise for `new`/const chains; for a `let`/`var` (possibly reassigned)
   *  or an unknown shape it falls back to "does the enclosing function build any poly
   *  value" — conservative but sound. Params / `this` / call / field results can't be
   *  polymorphic (such a value can't escape its constructing function — see
   *  devirt::compute_poly_taint's loud-fail), so they return false. */
  exprMayBePolyInstance(expr: ts.Expression): boolean {
    let e: ts.Expression = expr;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isNewExpression(e)) return this.isCollapsedPolyNew(e);
    if (ts.isIdentifier(e)) {
      const sym = this.symbolOf(e);
      const decls = sym?.getDeclarations?.() ?? [];
      if (decls.length === 1 && ts.isVariableDeclaration(decls[0])) {
        const d = decls[0];
        const list = d.parent;
        const isConst = !!(list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const));
        if (isConst && d.initializer) return this.exprMayBePolyInstance(d.initializer);
        // let/var (possibly reassigned) or no initializer: poly iff this function
        // builds any poly value (the var could hold it).
        const fn = this.enclosingFunction(d) ?? (this.moduleInitNode as unknown as ts.Node | undefined);
        return fn ? this.fnHasCollapsedPolyNew(fn) : false;
      }
      return false; // parameter / import / class / etc.
    }
    return false; // call / field / element / this: never a (non-escaping) poly value
  }

  recordInstantiationFieldTypes(classId: number, node: ts.NewExpression) {
    if (!this.strictTypeOptimizationsEnabled()) return;
    if (!this.callArgumentsSafe(node.arguments)) return;
    try {
      const t = this.checker.getTypeAtLocation(node);
      // The instance is an instance of every ancestor too: their own fields
      // take their types from the same instance type, so a base class that is
      // constructed only through `super` (tsc-ts's Node, Symbol, Type) gets its
      // field representation from its subclasses' instantiations. An ancestor
      // whose body is not optimization-safe ends the walk (its fields stay
      // boxed, as do those above it).
      for (let id: number | undefined = classId; id !== undefined; ) {
        const info: ClassInfo | undefined = this.classInfos[id];
        if (!info) return;
        const decl = this.classNodeOfId.get(id);
        // A class stored into dynamically (an element store, Object.assign)
        // keeps every field boxed, and so do the classes above it; otherwise a
        // field is typed unless some store to it is unsafe
        // (collectUnsafeFieldStores): casts in the class body no longer box
        // every field of tsc-ts's Type, whose accessors downcast `this`.
        if (decl && this.unsafeStoreClasses.has(decl)) return;
        let m = this.instFieldTypes.get(id);
        if (!m) { m = new Map(); this.instFieldTypes.set(id, m); }
        for (const fname of info.ownFields) {
          const prop = this.checker.getPropertyOfType(t, fname);
          let tag = "tsv";
          if (prop && !(prop.declarations ?? []).some((d) => this.unsafeFieldDecls.has(d))) {
            const ft = this.checker.getTypeOfSymbolAtLocation(prop, node);
            tag = this.classify(ft) === "primitive" ? (this.isInt32ValuedType(ft) ? "int32" : "number") : "tsv";
          }
          if (!m.has(fname)) m.set(fname, new Set());
          m.get(fname)!.add(tag);
        }
        id = info.parentId;
      }
    } catch { /* be conservative on any checker hiccup */ }
  }

  /** Is every value of `t` an int32? A numeric enum whose members are all
   *  int32 constants, a member of one, or a union of int32 literal types
   *  (docs/int32_fields_design.md). Such a field is stored as an integer. */
  isInt32ValuedType(t: ts.Type): boolean {
    const F = ts.TypeFlags;
    const int32 = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
    const literalOk = (m: ts.Type): boolean => {
      if (m.flags & F.NumberLiteral) return int32((m as ts.NumberLiteralType).value);
      return false;
    };
    try {
      if (t.flags & F.Union) return (t as ts.UnionType).types.every((m) => literalOk(m) || ((m.flags & F.EnumLiteral) !== 0 && literalOk(m)));
      if (t.flags & F.EnumLiteral) return literalOk(t);
      if (t.flags & F.Enum) {
        const sym = t.getSymbol();
        if (!sym || !sym.declarations) return false;
        for (const d of sym.declarations) {
          if (!ts.isEnumDeclaration(d)) return false;
          for (const m of d.members) {
            const v = this.checker.getConstantValue(m);
            if (!int32(v)) return false;
          }
        }
        return true;
      }
    } catch { return false; }
    return false;
  }
  /** Resolve uniform (monomorphic) field types for a class: a field gets a
   *  concrete tag only if every instantiation agreed on the same scalar tag. */
  uniformFieldTypes(classId: number): Record<string, string> {
    const out: Record<string, string> = {};
    const m = this.instFieldTypes.get(classId);
    if (!m) return out;
    for (const [fname, tags] of m) {
      if (tags.size === 1) {
        const tag = [...tags][0];
        if (tag === "number" || tag === "int32") out[fname] = tag; // only specialize true scalars
      } else if (tags.size === 2 && tags.has("number") && tags.has("int32")) {
        out[fname] = "number"; // an int32 at some sites, a number at others: a double
      }
    }
    return out;
  }

  /** Lower a prototype argument: `C.prototype` -> the constructor value's current
   *  prototype object; anything else lowers normally. */
  /** Classify a receiver expression as a builtin "string"/"array" type, or
   *  undefined if it is not a known builtin (e.g. a user class, any, object). */
  /** Resolve a namespace call like Math.sqrt / Number.isInteger / Date.now to a
   *  static builtin name, "__UNSUPPORTED__" if the namespace is known but the
   *  member/arity is not implemented, or undefined if not a known namespace. */
  /** Math.PI / Number.MAX_SAFE_INTEGER etc. -> a concrete numeric value, or
   *  undefined if not a recognized constant. */
  /** The symbol name of an expression's type (e.g. "Date", "Map"), or undefined. */
  typeNameOf(e: ts.Expression): string | undefined {
    try {
      const t = this.checker.getTypeAtLocation(e);
      return t.getSymbol()?.name;
    } catch { return undefined; }
  }

  namespaceConstant(ns: string, member: string): number | undefined {
    if (ns === "Math") {
      switch (member) {
        case "PI": return Math.PI;
        case "E": return Math.E;
        case "LN2": return Math.LN2;
        case "LN10": return Math.LN10;
        case "LOG2E": return Math.LOG2E;
        case "LOG10E": return Math.LOG10E;
        case "SQRT2": return Math.SQRT2;
        case "SQRT1_2": return Math.SQRT1_2;
      }
    }
    if (ns === "Number") {
      switch (member) {
        case "MAX_SAFE_INTEGER": return Number.MAX_SAFE_INTEGER;
        case "MIN_SAFE_INTEGER": return Number.MIN_SAFE_INTEGER;
        case "MAX_VALUE": return Number.MAX_VALUE;
        case "MIN_VALUE": return Number.MIN_VALUE;
        case "EPSILON": return Number.EPSILON;
        // POSITIVE/NEGATIVE_INFINITY intentionally omitted: Infinity is not valid
        // JSON and would corrupt the IR. They fall through (unsupported) for now.
      }
    }
    const taElem = TYPED_ARRAY_ELEMS.get(ns);
    if (taElem !== undefined && member === "BYTES_PER_ELEMENT") return TYPED_ARRAY_BYTES[taElem];
    return undefined;
  }

  /** Lower a single Object.defineProperty descriptor onto a pre-lowered object
   *  and key local. Shared by Object.defineProperty and Object.defineProperties.
   *  Emits the appropriate object.defineData / object.defineAccessor builtin, or
   *  calls this.unsupported(...) for shapes that can't be modeled. */
  lowerDefineOneProperty(ctx: FnCtx, node: ts.Node, obj: number, key: number, desc: ts.ObjectLiteralExpression): void {
    let valueProp: ts.PropertyAssignment | undefined;
    let getProp: ts.ObjectLiteralElementLike | undefined;
    let setProp: ts.ObjectLiteralElementLike | undefined;
    let hasAnyAttr = false;
    // Attributes default to FALSE when OMITTED (Object.defineProperty semantics),
    // unlike a literal `{x:1}` (all true). tri-state: undefined = omitted.
    let enumAttr: boolean | undefined, writeAttr: boolean | undefined, confAttr: boolean | undefined;
    let attrNonLiteral = false;
    const boolLit = (e: ts.Expression): boolean | undefined =>
      e.kind === ts.SyntaxKind.TrueKeyword ? true :
      e.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
    for (const pr of desc.properties) {
      const nm = pr.name && (ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name)) ? pr.name.text : undefined;
      // get/set forms:
      //  - function value:    { get: fn }      -> PropertyAssignment named "get"
      //  - method shorthand:  { get() {} }     -> MethodDeclaration named "get"
      //    (note: `{ get() {} }` parses as a METHOD called "get", NOT a
      //     GetAccessorDeclaration; the latter is `{ get x() {} }`.)
      if (nm === "value" && ts.isPropertyAssignment(pr)) valueProp = pr;
      else if (nm === "get" && (ts.isPropertyAssignment(pr) || ts.isMethodDeclaration(pr))) getProp = pr;
      else if (nm === "set" && (ts.isPropertyAssignment(pr) || ts.isMethodDeclaration(pr))) setProp = pr;
      else if (nm === "enumerable" || nm === "writable" || nm === "configurable") {
        hasAnyAttr = true;
        const v = ts.isPropertyAssignment(pr) ? boolLit(pr.initializer) : undefined;
        if (v === undefined) attrNonLiteral = true;
        else if (nm === "enumerable") enumAttr = v;
        else if (nm === "writable") writeAttr = v;
        else confAttr = v;
      }
    }
    const isAccessor = getProp !== undefined || setProp !== undefined;
    if (isAccessor && valueProp !== undefined) {
      this.unsupported(node, "Object.defineProperty descriptor with both value and get/set");
      return;
    }
    if (attrNonLiteral) {
      // An attribute value isn't a boolean literal (e.g. `{ value: 1, writable: w }`).
      // We can't read it statically, so lower the descriptor object as a normal
      // expression and dispatch to the runtime descriptor-inspection path.
      const descLocal = this.lowerExpr(ctx, desc);
      ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
        builtin: "object.definePropertyDyn", args: [obj, key, descLocal] });
      return;
    }
    if (isAccessor) {
      // accessor get/set: lower each side to a closure. Two source forms:
      //  (a) function-value:    { get: () => .. }  / { get: function(){..} }
      //  (b) method-shorthand:  { get() {..} }      (GetAccessorDeclaration)
      // A function-expression / method-shorthand binds this=object (reserve arg0);
      // an arrow uses lexical this (no reserved slot). g_this/s_this reflect that.
      const undefLocal = () => { const u = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } }); return u; };
      const lowerAccessorSide = (p: ts.ObjectLiteralElementLike | undefined, hint: string):
          { local: number; takesThis: number } => {
        if (!p) return { local: undefLocal(), takesThis: 0 };
        // method-shorthand `{ get() {} }` parses as a MethodDeclaration -> lift its
        // body as a function-expression (this = object, so reserve arg0).
        if (ts.isMethodDeclaration(p)) {
          const local = this.lowerClosure(ctx, p as unknown as FnLike, hint, /*thisParam*/ true);
          return { local, takesThis: 1 };
        }
        if (ts.isPropertyAssignment(p)) {
          const init = p.initializer;
          if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) {
            this.unsupported(node, `Object.defineProperty ${hint} must be a function`);
            return { local: undefLocal(), takesThis: 0 };
          }
          const takesThis = ts.isFunctionExpression(init) ? 1 : 0;
          const local = this.lowerClosure(ctx, init, hint, takesThis === 1);
          return { local, takesThis };
        }
        this.unsupported(node, `Object.defineProperty ${hint} has an unsupported form`);
        return { local: undefLocal(), takesThis: 0 };
      };
      const g = lowerAccessorSide(getProp, "getter");
      const s = lowerAccessorSide(setProp, "setter");
      // accessor attributes: enumerable/configurable default to false when
      // omitted. Both are now honored (the enumeration path lists enumerable
      // accessors and invokes the getter for their value).
      const ce = enumAttr === true ? 1 : 0;  // enumerable
      const cc = confAttr === true ? 1 : 0;  // configurable
      // builtin carries g_this:s_this:enumerable:configurable:present, the last
      // the fields the descriptor names (1 get, 2 set, 4 enumerable,
      // 8 configurable): a property that exists keeps the others.
      const present = (getProp ? 1 : 0) | (setProp ? 2 : 0) | (enumAttr !== undefined ? 4 : 0) | (confAttr !== undefined ? 8 : 0);
      ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
        builtin: `object.defineAccessor:${g.takesThis}:${s.takesThis}:${ce}:${cc}:${present}`, args: [obj, key, g.local, s.local] });
      return;
    }
    // data (value) descriptor. A descriptor with no value/get/set (e.g. `{}` or
    // `{ enumerable: true }`) is valid in JS: value defaults to undefined,
    // attributes to false. Synthesize undefined rather than rejecting.
    const e = enumAttr === true ? 1 : 0;
    const w = writeAttr === true ? 1 : 0;
    const c = confAttr === true ? 1 : 0;
    let valLocal: number;
    if (valueProp === undefined) {
      valLocal = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: valLocal, value: { kind: "Undef" } });
    } else {
      valLocal = this.lowerExpr(ctx, valueProp.initializer);
    }
    // the last field: the fields the descriptor names (1 value, 2 writable,
    // 4 enumerable, 8 configurable): a property that exists keeps the others
    const present = (valueProp ? 1 : 0) | (writeAttr !== undefined ? 2 : 0) | (enumAttr !== undefined ? 4 : 0) | (confAttr !== undefined ? 8 : 0);
    ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
      builtin: `object.defineData:${e}:${w}:${c}:${present}`, args: [obj, key, valLocal] });
  }

  lowerJsonConstValue(ctx: FnCtx, value: unknown, siteNode: ts.Node): number {
    if (value === null) {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Null" } });
      return dst;
    }
    if (typeof value === "number") {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Num", value: this.numWire(value) } });
      return dst;
    }
    if (typeof value === "boolean") {
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Bool", value } });
      return dst;
    }
    if (typeof value === "string") {
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst, value: { kind: "Str", value } });
      return dst;
    }
    if (Array.isArray(value)) {
      const site = this.site++;
      this.recordSite(site, "array", this.inLoop(siteNode) ? "many" : "once", false, siteNode);
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "AllocArray", dst, elemType: 0, site });
      for (let i = 0; i < value.length; i++) {
        const elem = this.lowerJsonConstValue(ctx, value[i], siteNode);
        const idx = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst: idx, value: { kind: "Num", value: i } });
        ctx.body.push({ kind: "StoreIndex", arr: dst, index: idx, src: elem });
      }
      return dst;
    }
    if (typeof value === "object") {
      const site = this.site++;
      this.recordSite(site, "object", this.inLoop(siteNode) ? "many" : "once", false, siteNode);
      const dst = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "AllocObject", dst, typeId: 0, site });
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const val = this.lowerJsonConstValue(ctx, v, siteNode);
        ctx.body.push({ kind: "StoreField", obj: dst, field: this.internField(k), src: val });
      }
      return dst;
    }
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst, value: { kind: "Undef" } });
    return dst;
  }

  private jsonConstLen(ctx: FnCtx, n: number): number {
    const dst = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst, value: { kind: "Num", value: n } });
    return dst;
  }

  private addJsonLen(ctx: FnCtx, a: number, b: number): number {
    const dst = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "BinOp", dst, op: "+", lhs: a, rhs: b });
    return dst;
  }

  private jsonObjectKeyName(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (ts.isNumericLiteral(name)) return String(Number(name.text));
    return undefined;
  }

  private classFieldNamesForJson(classId: number): string[] {
    const names: string[] = [];
    const visit = (cid: number | undefined) => {
      if (cid === undefined) return;
      const ci = this.classInfos[cid];
      visit(ci?.parentId);
      for (const f of ci?.ownFields ?? []) names.push(f);
    };
    visit(classId);
    return names;
  }

  private jsonExprPrimitiveKind(expr: ts.Expression): "number" | "string" | "boolean" | undefined {
    try {
      const t = this.checker.getTypeAtLocation(expr);
      const F = ts.TypeFlags;
      if (t.flags & F.NumberLike) return "number";
      if (t.flags & F.StringLike) return "string";
      if (t.flags & F.BooleanLike) return "boolean";
    } catch { /* fall through */ }
    return undefined;
  }

  private classFieldJsonKind(classId: number, field: string): "number" | "string" | "boolean" | undefined {
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const node = this.classNodeOfId.get(cur);
      if (node) {
        for (const m of node.members) {
          if (!ts.isPropertyDeclaration(m) || !m.name) continue;
          const name = this.jsonObjectKeyName(m.name);
          if (name !== field) continue;
          if (m.type) {
            if (m.type.kind === ts.SyntaxKind.NumberKeyword) return "number";
            if (m.type.kind === ts.SyntaxKind.StringKeyword) return "string";
            if (m.type.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
          }
          try {
            const t = this.checker.getTypeAtLocation(m);
            const F = ts.TypeFlags;
            if (t.flags & F.NumberLike) return "number";
            if (t.flags & F.StringLike) return "string";
            if (t.flags & F.BooleanLike) return "boolean";
          } catch { /* fall through */ }
        }
      }
      cur = this.classInfos[cur]?.parentId;
    }
    return undefined;
  }

  private lowerJsonLeafLen(ctx: FnCtx, expr: ts.Expression, siteNode: ts.Node, indent: string | undefined): number | undefined {
    const kind = this.jsonExprPrimitiveKind(expr);
    if (kind !== "number" && kind !== "string") return undefined;
    const val = this.lowerExpr(ctx, expr);
    const dst = this.newLocal(ctx, "primitive");
    if (kind === "number") {
      ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "json.num.len", args: [val] });
    } else if (kind === "string") {
      ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "json.string.len", args: [val] });
    }
    return dst;
  }

  canLowerJsonStringifyLenStatic(expr: ts.Expression): boolean {
    let e: ts.Expression = expr;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) return true;
    if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isArrayLiteralExpression(e)) return e.elements.every((el) => !ts.isSpreadElement(el) && this.canLowerJsonStringifyLenStatic(el as ts.Expression));
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.every((p) => ts.isPropertyAssignment(p) &&
        this.jsonObjectKeyName(p.name) !== undefined &&
        this.canLowerJsonStringifyLenStatic(p.initializer));
    }
    const tn = this.typeNameOf(e);
    const cid = tn !== undefined ? this.classInfos.find((c) => c.name === tn)?.id : undefined;
    if (cid !== undefined) {
      const fields = this.classFieldNamesForJson(cid);
      return fields.length > 0 && fields.every((field) => {
        const k = this.classFieldJsonKind(cid, field);
        return k === "number" || k === "string";
      });
    }
    const k = this.jsonExprPrimitiveKind(e);
    return k === "number" || k === "string";
  }

  lowerJsonStringifyLenStatic(ctx: FnCtx, expr: ts.Expression, siteNode: ts.Node, indent: string | undefined = undefined, depth = 0): number | undefined {
    let e: ts.Expression = expr;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;

    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return this.jsonConstLen(ctx, JSON.stringify(e.text).length);
    if (ts.isNumericLiteral(e)) return this.jsonConstLen(ctx, JSON.stringify(Number(e.text)).length);
    if (e.kind === ts.SyntaxKind.TrueKeyword) return this.jsonConstLen(ctx, 4);
    if (e.kind === ts.SyntaxKind.FalseKeyword) return this.jsonConstLen(ctx, 5);
    if (e.kind === ts.SyntaxKind.NullKeyword) return this.jsonConstLen(ctx, 4);

    const addConst = (acc: number, n: number) => n === 0 ? acc : this.addJsonLen(ctx, acc, this.jsonConstLen(ctx, n));

    if (ts.isArrayLiteralExpression(e)) {
      if (e.elements.length === 0) return this.jsonConstLen(ctx, 2);
      let acc = this.jsonConstLen(ctx, 1); // [
      for (let i = 0; i < e.elements.length; i++) {
        const el = e.elements[i];
        const vlen = this.lowerJsonStringifyLenStatic(ctx, el as ts.Expression, siteNode, indent, depth + 1)
          ?? this.lowerJsonLeafLen(ctx, el as ts.Expression, siteNode, indent);
        if (vlen === undefined) return undefined;
        const prefix = indent === undefined
          ? (i > 0 ? 1 : 0)
          : (i > 0 ? 1 : 0) + 1 + indent.length * (depth + 1);
        acc = addConst(acc, prefix);
        acc = this.addJsonLen(ctx, acc, vlen);
      }
      acc = addConst(acc, indent === undefined ? 1 : 1 + indent.length * depth + 1); // ] or \n + indent + ]
      return acc;
    }

    if (ts.isObjectLiteralExpression(e)) {
      const props: { key: string; value: ts.Expression }[] = [];
      for (const p of e.properties) {
        if (!ts.isPropertyAssignment(p)) return undefined;
        const key = this.jsonObjectKeyName(p.name);
        if (key === undefined) return undefined;
        props.push({ key, value: p.initializer });
      }
      if (props.length === 0) return this.jsonConstLen(ctx, 2);
      let acc = this.jsonConstLen(ctx, 1); // {
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        const vlen = this.lowerJsonStringifyLenStatic(ctx, p.value, siteNode, indent, depth + 1)
          ?? this.lowerJsonLeafLen(ctx, p.value, siteNode, indent);
        if (vlen === undefined) return undefined;
        const keyLen = JSON.stringify(p.key).length;
        const prefix = indent === undefined
          ? (i > 0 ? 1 : 0) + keyLen + 1
          : (i > 0 ? 1 : 0) + 1 + indent.length * (depth + 1) + keyLen + 2;
        acc = addConst(acc, prefix);
        acc = this.addJsonLen(ctx, acc, vlen);
      }
      acc = addConst(acc, indent === undefined ? 1 : 1 + indent.length * depth + 1); // } or \n + indent + }
      return acc;
    }

    const tn = this.typeNameOf(e);
    const cid = tn !== undefined ? this.classInfos.find((c) => c.name === tn)?.id : undefined;
    if (cid !== undefined) {
      const fields = this.classFieldNamesForJson(cid);
      if (fields.length > 0) {
        const kinds = fields.map((field) => this.classFieldJsonKind(cid, field));
        if (kinds.some((k) => k !== "number" && k !== "string")) return undefined;
        const obj = this.lowerExpr(ctx, e);
        let acc = this.jsonConstLen(ctx, 1); // {
        fields.forEach((field, i) => {
          const kind = kinds[i];
          const val = this.newLocal(ctx, kind === "number" ? "primitive" : "reference");
          ctx.body.push({ kind: "LoadField", dst: val, obj, field: this.internField(field) });
          const vlen = this.newLocal(ctx, "primitive");
          if (kind === "number") ctx.body.push({ kind: "CallBuiltinStatic", dst: vlen, builtin: "json.num.len", args: [val] });
          else if (kind === "string") ctx.body.push({ kind: "CallBuiltinStatic", dst: vlen, builtin: "json.string.len", args: [val] });
          acc = addConst(acc, (i > 0 ? 1 : 0) + JSON.stringify(field).length + 1);
          acc = this.addJsonLen(ctx, acc, vlen);
        });
        acc = addConst(acc, 1); // }
        return acc;
      }
    }

    return undefined;
  }

  namespaceBuiltin(ns: string, member: string, argc: number): string | undefined {
    if (ns === "Math") {
      const oneArg = new Set(["sqrt","abs","floor","ceil","round","trunc","sign",
        "sin","cos","tan","asin","acos","atan","sinh","cosh","tanh",
        "exp","log","log2","log10","cbrt",
        "asinh","acosh","atanh","expm1","log1p","fround","f16round","clz32"]);
      const twoArg = new Set(["pow","atan2","hypot","max","min","imul"]);
      if (member === "random") return argc === 0 ? "math.random" : "__UNSUPPORTED__";
      if (oneArg.has(member)) return argc === 1 ? `math.${member}` : "__UNSUPPORTED__";
      if (twoArg.has(member)) return argc === 2 ? `math.${member}` : "__UNSUPPORTED__";
      return "__UNSUPPORTED__"; // Math.* but unknown/unimplemented
    }
    if (ns === "Number") {
      const m = new Set(["isInteger","isFinite","isNaN","isSafeInteger","parseFloat","parseInt"]);
      if (m.has(member)) return `number.${member}`;
      return "__UNSUPPORTED__";
    }
    if (ns === "Date") {
      if (member === "now") return "date.now";
      if (member === "parse") return argc === 1 ? "date.parse" : "__UNSUPPORTED__";
      if (member === "UTC") return argc >= 1 && argc <= 7 ? `date.utc:${argc}` : "__UNSUPPORTED__";
      return "__UNSUPPORTED__";
    }
    if (ns === "Object") {
      // getPrototypeOf / setPrototypeOf are handled by a dedicated branch; let
      // them fall through (return undefined). keys/values/entries now supported
      // via the field-name table; other statics rejected loudly.
      if (member === "getPrototypeOf" || member === "setPrototypeOf") return undefined;
      if (member === "is") return undefined; // handled by a dedicated branch (SameValue)
      if (member === "keys" || member === "values" || member === "entries") return `object.${member}`;
      if (member === "getOwnPropertySymbols") return argc === 1 ? "object.getOwnPropertySymbols" : "__UNSUPPORTED__";
      if (member === "assign") return argc >= 1 ? "object.assign" : "__UNSUPPORTED__";
      if (member === "fromEntries") return argc === 1 ? "object.fromEntries" : "__UNSUPPORTED__";
      if (member === "freeze") return argc === 1 ? "object.freeze" : "__UNSUPPORTED__";
      if (member === "isFrozen") return argc === 1 ? "object.isFrozen" : "__UNSUPPORTED__";
      if (member === "seal") return argc === 1 ? "object.seal" : "__UNSUPPORTED__";
      if (member === "preventExtensions") return argc === 1 ? "object.preventExtensions" : "__UNSUPPORTED__";
      if (member === "isSealed") return argc === 1 ? "object.isSealed" : "__UNSUPPORTED__";
      if (member === "isExtensible") return argc === 1 ? "object.isExtensible" : "__UNSUPPORTED__";
      // Object.create(proto): the property-descriptor 2nd arg form is not supported.
      if (member === "create") return argc === 1 ? "object.create" : "__UNSUPPORTED__";
      if (member === "hasOwn") return argc === 2 ? "object.hasOwn" : "__UNSUPPORTED__";
      if (member === "getOwnPropertyNames") return argc === 1 ? "object.getOwnPropertyNames" : "__UNSUPPORTED__";
      if (member === "getOwnPropertyDescriptor") return argc === 2 ? "object.getOwnPropertyDescriptor" : "__UNSUPPORTED__";
      if (member === "getOwnPropertyDescriptors") return argc === 1 ? "object.getOwnPropertyDescriptors" : "__UNSUPPORTED__";
      return "__UNSUPPORTED__";
    }
    if (ns === "JSON") {
      if (member === "stringify") return argc <= 1 ? "json.stringify" : "__UNSUPPORTED__"; // replacer/space unsupported
      if (member === "parse") return argc === 1 ? "json.dom.parse" : (argc === 2 ? "json.parse" : "__UNSUPPORTED__"); // optional reviver
      return "__UNSUPPORTED__";
    }
    if (ns === "String") {
      if (member === "fromCharCode") return "string.fromCharCode";     // variadic
      if (member === "fromCodePoint") return "string.fromCodePoint";   // variadic
      return "__UNSUPPORTED__";
    }
    if (ns === "Array") {
      if (member === "isArray") return argc === 1 ? "array.isArray" : "__UNSUPPORTED__";
      if (member === "of") return "array.of";                         // variadic
      // Array.from(iterable | arrayLike [, mapFn]).
      if (member === "from") return (argc === 1 || argc === 2) ? "array.from" : "__UNSUPPORTED__";
      return "__UNSUPPORTED__";
    }
    const taElem = TYPED_ARRAY_ELEMS.get(ns);
    if (taElem !== undefined) {
      if (member === "of") return `typedarray.of:${taElem}`;           // variadic
      // T.from(iterable | arrayLike [, mapFn [, thisArg]]).
      if (member === "from") return (argc >= 1 && argc <= 3) ? `typedarray.from:${taElem}` : "__UNSUPPORTED__";
      return "__UNSUPPORTED__";
    }
    if (ns === "ArrayBuffer") {
      if (member === "isView") return argc === 1 ? "arraybuffer.isView" : "__UNSUPPORTED__";
      return "__UNSUPPORTED__";
    }
    // Atomics on one thread (docs/typed_arrays_design.md, TA3); a missing
    // operand reads undefined.
    if (ns === "Atomics") {
      const arity: Record<string, number> = { load: 2, store: 3, add: 3, sub: 3, and: 3, or: 3, xor: 3,
        exchange: 3, compareExchange: 4, isLockFree: 1, wait: 4, notify: 3 };
      if (!Object.prototype.hasOwnProperty.call(arity, member)) return "__UNSUPPORTED__";
      return argc <= arity[member] ? `atomics.${member}` : "__UNSUPPORTED__";
    }
    if (ns === "AbortSignal") {
      if (member === "timeout") return argc === 1 ? "abortsignal.timeout" : "__UNSUPPORTED__";
      return undefined;
    }
    if (ns === "Reflect") {
      // Reflect mirrors the proxy traps. get/set/construct accept an optional
      // trailing arg (receiver / newTarget) which v1 ignores.
      if (member === "get") return (argc === 2 || argc === 3) ? "reflect.get" : "__UNSUPPORTED__";
      if (member === "set") return (argc === 3 || argc === 4) ? "reflect.set" : "__UNSUPPORTED__";
      if (member === "has") return argc === 2 ? "reflect.has" : "__UNSUPPORTED__";
      if (member === "deleteProperty") return argc === 2 ? "reflect.deleteProperty" : "__UNSUPPORTED__";
      if (member === "ownKeys") return argc === 1 ? "reflect.ownKeys" : "__UNSUPPORTED__";
      if (member === "getPrototypeOf") return argc === 1 ? "reflect.getPrototypeOf" : "__UNSUPPORTED__";
      if (member === "setPrototypeOf") return argc === 2 ? "reflect.setPrototypeOf" : "__UNSUPPORTED__";
      if (member === "defineProperty") return argc === 3 ? "reflect.defineProperty" : "__UNSUPPORTED__";
      if (member === "getOwnPropertyDescriptor") return argc === 2 ? "reflect.getOwnPropertyDescriptor" : "__UNSUPPORTED__";
      if (member === "isExtensible") return argc === 1 ? "reflect.isExtensible" : "__UNSUPPORTED__";
      if (member === "preventExtensions") return argc === 1 ? "reflect.preventExtensions" : "__UNSUPPORTED__";
      if (member === "apply") return argc === 3 ? "reflect.apply" : "__UNSUPPORTED__";
      if (member === "construct") return (argc === 2 || argc === 3) ? "reflect.construct" : "__UNSUPPORTED__";
      return "__UNSUPPORTED__";
    }
    if (ns === "Proxy") {
      if (member === "revocable") return argc === 2 ? "proxy.revocable" : "__UNSUPPORTED__";
      return "__UNSUPPORTED__";
    }
    return undefined;
  }

  /** True for an object type that is an array type or an interface (a type
   *  reference's target) whose base types reach the global Array or
   *  ReadonlyArray. Classes are excluded (a class extending Array keeps the
   *  dynamic paths). */
  /** `TSAOT_MAP_INTERFACES=0`: interfaces extending Map/Set keep the dynamic dispatch. */
  mapInterfaces = process.env.TSAOT_MAP_INTERFACES !== "0" && process.env.TSAOT_UNTYPED !== "1";
  /** A receiver typed as an interface whose base types reach Map/ReadonlyMap or
   *  Set/ReadonlySet (the compiler's `MultiMap<K, V> extends Map<K, V[]>`): its
   *  instances are Maps/Sets with extra typing, so a builtin member (`get`,
   *  `has`, `size`, `for..of`) takes the collection path; its own members keep
   *  the dynamic dispatch. A non-collection receiver throws the TypeError V8
   *  throws for a Map method on an incompatible receiver. */
  derivedCollectionKind(recvExpr: ts.Expression): "map" | "set" | undefined {
    if (!this.mapInterfaces) return undefined;
    try {
      const t = this.checker.getTypeAtLocation(recvExpr);
      const nn = t.getNonNullableType ? t.getNonNullableType() : t;
      const sym = nn.getSymbol();
      if (!sym || this.isAmbientGlobalSymbol(sym)) return undefined;
      if (this.isCollectionDerivedType(nn, 0, "Map")) return "map";
      if (this.isCollectionDerivedType(nn, 0, "Set")) return "set";
    } catch { /* fall through */ }
    return undefined;
  }
  /** An interface whose base types reach the ambient Map/ReadonlyMap (`which`
   *  "Map") or Set/ReadonlySet ("Set"). */
  private isCollectionDerivedType(t: ts.Type, depth: number, which: "Map" | "Set"): boolean {
    if (depth > 6 || !(t.flags & ts.TypeFlags.Object)) return false;
    const ot = t as ts.ObjectType;
    const target = (ot.objectFlags & ts.ObjectFlags.Reference) ? (ot as ts.TypeReference).target : ot;
    if (!(target.objectFlags & ts.ObjectFlags.Interface)) return false;
    const tsym = target.getSymbol();
    if (tsym && (tsym.name === which || tsym.name === "Readonly" + which) && this.isAmbientGlobalSymbol(tsym)) return true;
    let bases: readonly ts.BaseType[] = [];
    try { bases = this.checker.getBaseTypes(target as ts.InterfaceType); } catch { return false; }
    return bases.some((b) => this.isCollectionDerivedType(b, depth + 1, which));
  }
  /** The library's `RegExpMatchArray` / `RegExpExecArray`: interfaces over Array<string> whose
   *  instances are the regexp result arrays (lib.es5.d.ts; a user type of the same name is not). */
  private isRegExpResultSymbol(sym: ts.Symbol): boolean {
    return (sym.name === "RegExpMatchArray" || sym.name === "RegExpExecArray") && this.isAmbientGlobalSymbol(sym);
  }
  /** An array at run time: an array or tuple type, a RegExp result type, or an interface derived
   *  from Array (the member test of a union of arrays). */
  private isArrayKindType(m: ts.Type): boolean {
    if (this.checker.isArrayType(m) || this.checker.isTupleType(m)) return true;
    const sym = m.getSymbol();
    if (!sym) return false;
    if (this.isRegExpResultSymbol(sym)) return true;
    return !this.isAmbientGlobalSymbol(sym) && this.arrayInterfaces && this.isArrayDerivedType(m, 0);
  }
  private isArrayDerivedType(t: ts.Type, depth: number): boolean {
    if (depth > 6 || !(t.flags & ts.TypeFlags.Object)) return false;
    if (this.checker.isArrayType(t)) return true;
    const ot = t as ts.ObjectType;
    const target = (ot.objectFlags & ts.ObjectFlags.Reference) ? (ot as ts.TypeReference).target : ot;
    if (!(target.objectFlags & ts.ObjectFlags.Interface)) return false;
    const tsym = target.getSymbol();
    if (tsym && (tsym.name === "Array" || tsym.name === "ReadonlyArray") && this.isAmbientGlobalSymbol(tsym)) return true;
    let bases: readonly ts.BaseType[] = [];
    try { bases = this.checker.getBaseTypes(target as ts.InterfaceType); } catch { return false; }
    return bases.some((b) => this.isArrayDerivedType(b, depth + 1));
  }

  /** `.length` of this receiver is a builtin string's or array's number
   * (GenericLen): on every member of the receiver's type, `length` resolves to
   * the declaration in the default library's String, Array or ReadonlyArray
   * (tuples, NodeArray, `Readonly<string[] & ...>`, a type parameter so
   * constrained). Other receivers (an object with a `length` field such as
   * TextSpan, ArrayLike, typed arrays, functions, any, unknown) read the
   * property. Null and undefined members only pass in an optional chain,
   * whose guard has excluded them. */
  lengthIsBuiltinNumber(access: ts.PropertyAccessExpression): boolean {
    let t: ts.Type;
    try { t = this.checker.getTypeAtLocation(access.expression); } catch { return false; }
    const F = ts.TypeFlags;
    const optional = ts.isOptionalChain(access);
    const builtinOwners = new Set(["String", "Array", "ReadonlyArray"]);
    const builtin = (m: ts.Type, depth: number): boolean => {
      if (depth > 4) return false;
      if (m.flags & (F.Null | F.Undefined | F.Void)) return optional;
      if (m.flags & (F.String | F.StringLiteral | F.TemplateLiteral | F.StringMapping)) return true;
      if (m.flags & F.TypeParameter) {
        const c = this.checker.getBaseConstraintOfType(m);
        return !!c && c !== m && builtin(c, depth + 1);
      }
      if (m.flags & F.Union) return (m as ts.UnionType).types.every(u => builtin(u, depth + 1));
      const len = this.checker.getPropertyOfType(this.checker.getApparentType(m), "length");
      const decls = len?.declarations;
      if (!decls || decls.length === 0) return false;
      return decls.some(d => {
        const owner = d.parent;
        return ts.isInterfaceDeclaration(owner) && builtinOwners.has(owner.name.text) &&
          owner.getSourceFile().hasNoDefaultLib;
      });
    };
    return builtin(t, 0);
  }
  builtinReceiverKind(recvExpr: ts.Expression): "string" | "array" | "map" | "set" | "weakmap" | "weakset" | "headers" | "number" | "boolean" | "promise" | undefined {
    // Identify builtins whose runtime result is an array, including the existing
    // array/Headers iterator representations. Map/Set return actual iterators.
    let e: ts.Expression = recvExpr;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const innerKind = this.builtinReceiverKind(e.expression.expression);
      const meth = e.expression.name.text;
      const arrayReturning: Record<string, Set<string>> = {

        headers: new Set(["keys", "values", "entries"]),
        array: this.arrayIterForOfEnabled
          ? new Set(["map", "filter", "slice", "concat", "split", "flat", "flatMap", "toSorted", "toReversed", "toSpliced", "with"])
          : new Set(["map", "filter", "slice", "concat", "split", "entries", "keys", "values", "flat", "flatMap", "toSorted", "toReversed", "toSpliced", "with"]),
        string: new Set(["split"]),
      };
      if (innerKind && arrayReturning[innerKind]?.has(meth)) return "array";
    }
    const spec = this.typeSpecOfExpr(recvExpr);
    if (spec?.kind === "string") return "string";
    if (spec?.kind === "array") return "array";
    try {
      let t = this.checker.getTypeAtLocation(recvExpr);
      const F = ts.TypeFlags;
      // A callable value is never a string/array/map/set/number receiver. A stored
      // prototype method (`const f = Array.prototype.slice`) has type `(...) => any[]`,
      // whose `[]`-suffixed return would otherwise mis-classify `f.call(...)` as an
      // array instance and loud-reject. Functions have no array/string methods anyway.
      if (t.getCallSignatures().length > 0) return undefined;
      // A union of different kinds (`number[] | Set<number>`) has no single
      // builtin kind: its printed form would otherwise classify it by its first
      // member. Unions of one kind (with null / undefined) keep the checks below.
      if ((t.flags & F.Union) && this.unionMixesKinds(t as ts.UnionType)) return undefined;
      // A union whose every member is an array (hono's `Result<T>`: two tuple types behind an
      // alias, which the printed form below shows as the alias name): an array receiver, so an
      // element read is the element path and not a dynamic property get with a numeric key.
      if ((t.flags & F.Union) && (t as ts.UnionType).types.every((m) => this.isArrayKindType(m))) return "array";
      // A union with null / undefined only (an optional chain's result, `xs?.map(..).filter(..)`): the
      // kind of its other member. The printed form "Promise<string>[] | undefined" classified the
      // receiver by its element type as a promise (hono's streaming renderer).
      if (t.flags & F.Union) {
        const members = (t as ts.UnionType).types.filter((m) => !(m.flags & (F.Undefined | F.Null | F.Void)));
        if (members.length === 1) t = members[0];
      }
      if (t.flags & (F.String | F.StringLiteral)) return "string";
      const sym = t.getSymbol();
      // A user class shadowing a builtin name (`class Map {}`) is NOT a builtin
      // receiver — its methods are user methods, dispatched normally. Only the genuine
      // ambient builtin (all decls in .d.ts) routes to builtin kinds. (No nominal
      // symbol, e.g. array/tuple literal types, falls through to the structural checks
      // below.)
      // An interface whose base types reach Array/ReadonlyArray denotes a
      // runtime array: its instances are created as arrays and only carry
      // extra properties, so for-of, length and the builtin methods take the
      // array paths (the compiler's NodeArray<T>, 174 for-of loops).
      if (sym && !this.isAmbientGlobalSymbol(sym) && this.arrayInterfaces && this.isArrayDerivedType(t, 0)) return "array";
      // The library's RegExp result types (`RegExpMatchArray` and `RegExpExecArray` extend
      // Array<string>) are the runtime's result arrays with their named properties: the array
      // paths too. (A method on one was a dynamic call that probed each fresh result for an own
      // `indexOf` and filled an absent-cache entry per match: hono's RegExpRouter.)
      if (sym && this.isRegExpResultSymbol(sym)) return "array";
      // (An interface whose base types reach Map/Set is not a map/set receiver
      // in general: it may add its own methods, as the compiler's MultiMap does.
      // derivedCollectionKind serves the sites that ask about a builtin member.)
      if (sym && !this.isAmbientGlobalSymbol(sym)) return undefined;
      // Structural array/tuple identity takes precedence over the printed
      // element type: Map<K,V>[] starts with "Map<" but is not a Map receiver.
      if (this.checker.isArrayType(t) || this.checker.isTupleType(t)) return "array";
      const tn = this.checker.typeToString(t);
      if (sym && sym.name === "Map") return "map";
      if (sym && sym.name === "Set") return "set";
      if (sym && sym.name === "WeakMap") return "weakmap";
      if (sym && sym.name === "WeakSet") return "weakset";
      if (/^Map<|^ReadonlyMap</.test(tn)) return "map";
      if (/^Set<|^ReadonlySet</.test(tn)) return "set";
      if (/^WeakMap</.test(tn)) return "weakmap";
      if (/^WeakSet</.test(tn)) return "weakset";
      if (sym && sym.name === "Array") return "array";
      if (/\[\]$/.test(tn) || /^(readonly )?Array<|^readonly /.test(tn)) return "array";
      // Tuple types (e.g. `[number, number]`, `[number, ...number[]]`) are arrays
      // at runtime. The checker infers these for destructured rests and literals.
      if (/^(readonly )?\[/.test(tn)) return "array";
      if (sym && sym.name === "String") return "string";
      // numeric receiver: x.toFixed() / n.toString() etc. (number has no runtime
      // prototype; route to dedicated builtins).
      if (t.flags & (F.Number | F.NumberLiteral)) return "number";
      if (t.flags & F.BooleanLike) return "boolean";
      // Promise receiver: p.then/.catch/.finally -> promise builtins.
      if (sym && sym.name === "Promise") return "promise";
      if (/^Promise(Like)?</.test(tn)) return "promise";
    } catch { /* fallthrough */ }
    return undefined;
  }

  /** Whether the non-nullish members of a union fall into more than one
   *  receiver kind (array, string, number, boolean, or a named builtin; any
   *  other object type counts as its own kind). */
  private unionMixesKinds(u: ts.UnionType): boolean {
    const F = ts.TypeFlags;
    const kinds = new Set<string>();
    for (const m of u.types) {
      if (m.flags & (F.Undefined | F.Null | F.Void)) continue;
      if (m.flags & (F.String | F.StringLiteral | F.TemplateLiteral)) { kinds.add("string"); continue; }
      if (m.flags & (F.Number | F.NumberLiteral)) { kinds.add("number"); continue; }
      if (m.flags & F.BooleanLike) { kinds.add("boolean"); continue; }
      if (this.checker.isArrayType(m) || this.checker.isTupleType(m)) { kinds.add("array"); continue; }
      const sym = m.getSymbol();
      // an interface derived from Array / Map / Set is that kind at run time
      if (sym && !this.isAmbientGlobalSymbol(sym) && this.isArrayDerivedType(m, 0)) { kinds.add("array"); continue; }
      if (sym && this.isRegExpResultSymbol(sym)) { kinds.add("array"); continue; }
      if (sym && !this.isAmbientGlobalSymbol(sym) && this.isCollectionDerivedType(m, 0, "Map")) { kinds.add("map"); continue; }
      if (sym && !this.isAmbientGlobalSymbol(sym) && this.isCollectionDerivedType(m, 0, "Set")) { kinds.add("set"); continue; }
      if (sym && this.isAmbientGlobalSymbol(sym) && ["Map", "Set", "ReadonlyMap", "ReadonlySet", "WeakMap", "WeakSet", "Promise", "Array", "ReadonlyArray"].includes(sym.name)) {
        kinds.add(sym.name.replace(/^Readonly/, "").toLowerCase());
        continue;
      }
      kinds.add("object:" + ((m as any).id ?? this.checker.typeToString(m)));
    }
    return kinds.size > 1;
  }

  /** Map (builtin kind, method) to a runtime builtin name, or undefined if the
   *  method is not implemented for that kind. */
  builtinMethodName2(kind: "string" | "array" | "map" | "set" | "weakmap" | "weakset" | "headers" | "number" | "boolean" | "promise", method: string): string | undefined {
    const stringMethods = new Set([
      "toUpperCase","toLowerCase","toLocaleUpperCase","toLocaleLowerCase","slice","substring","indexOf","includes",
      "charAt","charCodeAt","codePointAt","concat","repeat","trim","split",
      "startsWith","endsWith","padStart","padEnd","trimStart","trimEnd",
      "trimLeft","trimRight","at","isWellFormed","toWellFormed",
      "replace","replaceAll","lastIndexOf","normalize","substr","toString","valueOf",
    ]);
    const arrayMethods = new Set([
      "map","filter","forEach","reduce","indexOf","includes","slice",
      "concat","join","push","pop",
      "find","findIndex","some","every","lastIndexOf","at","reverse",
      "shift","unshift","fill","sort","splice",
      "flat","flatMap","findLast","findLastIndex",
      "entries","keys","values","reduceRight","copyWithin","toString",
      "toSorted","toReversed","with","toSpliced",
    ]);
    const mapMethods = new Set(["set","get","has","delete","clear","keys","values","entries","forEach"]);
    const setMethods = new Set(["add","has","delete","clear","keys","values","entries","forEach"]);
    const weakMapMethods = new Set(["set","get","has","delete"]);
    const weakSetMethods = new Set(["add","has","delete"]);
    const numberMethods = new Set(["toFixed","toString","toPrecision","toExponential","valueOf"]);
    const booleanMethods = new Set(["toString","valueOf"]);
    const promiseMethods = new Set(["then","catch","finally"]);
    if (kind === "string" && stringMethods.has(method)) return `string.${method}`;
    if (kind === "array" && arrayMethods.has(method)) return `array.${method}`;
    if (kind === "map" && mapMethods.has(method)) return `map.${method}`;
    if (kind === "set" && setMethods.has(method)) return `set.${method}`;
    if (kind === "weakmap" && weakMapMethods.has(method)) return `weakmap.${method}`;
    if (kind === "weakset" && weakSetMethods.has(method)) return `weakset.${method}`;
    if (kind === "number" && numberMethods.has(method)) return `number.${method}`;
    if (kind === "boolean" && booleanMethods.has(method)) return `boolean.${method}`;
    if (kind === "promise" && promiseMethods.has(method)) return `promise.${method}`;
    return undefined;
  }

  /** A namespace member referenced AS A VALUE (`Math.sqrt`, `Object.keys`,
   *  `console.log`, `Array.isArray`, ...) -> the builtin name to box as a
   *  first-class function value, or undefined if not value-supported (caller
   *  loud-rejects). MUST stay in sync with emit_c's fnval_adapter_body table. */
  builtinFnValueName(ns: string, member: string): string | undefined {
    const math = new Set(["sqrt","abs","floor","ceil","sin","cos","tan","asin","acos","atan",
      "sinh","cosh","tanh","exp","log","asinh","acosh","atanh","expm1","log1p","fround",
      "f16round","round","trunc","sign","log2","log10","cbrt","clz32","pow","atan2","max","min","hypot","imul","random"]);
    const num = new Set(["isInteger","isFinite","isNaN","isSafeInteger","parseFloat","parseInt"]);
    const obj = new Set([
      "assign","create","getPrototypeOf","setPrototypeOf","keys","getOwnPropertyNames",
      "values","entries","fromEntries","freeze","seal","preventExtensions","isFrozen",
      "isSealed","isExtensible","hasOwn","is","getOwnPropertyDescriptor",
      "getOwnPropertyDescriptors","getOwnPropertySymbols",
    ]);
    const arr = new Set(["isArray","from","of"]);
    const str = new Set(["fromCharCode","fromCodePoint"]);
    if (ns === "Math" && math.has(member)) return `math.${member}`;
    if (ns === "Number" && num.has(member)) return `number.${member}`;
    if (ns === "Object" && obj.has(member)) return `object.${member}`;
    if (ns === "JSON" && (member === "stringify" || member === "parse")) return `json.${member}`;
    if (ns === "Array" && arr.has(member)) return `array.${member}`;
    if (ns === "String" && str.has(member)) return `string.${member}`;
    if (ns === "Promise" && (member === "resolve" || member === "reject" || member === "all" ||
        member === "race" || member === "allSettled" || member === "any")) return `promise.${member}`;
    if (ns === "AbortSignal" && member === "timeout") return "abortsignal.timeout";
    if (ns === "Symbol" && (member === "for" || member === "keyFor")) return `symbol.${member}`;
    if (ns === "Date" && member === "now") return "date.now";
    if (ns === "Date" && member === "parse") return "date.parse";
    if (ns === "console") {
      if (member === "log" || member === "info" || member === "debug") return "console.log";
      // `trace` as a value (hono's `onError = console.trace` default): the error writer; the stack lines are not modelled
      if (member === "error" || member === "warn" || member === "trace") return "console.error";
      if (member === "dir") return "console.dir";
    }
    return undefined;
  }

  /** A bare builtin global identifier referenced as a value (`Array`, `Math`,
   *  `parseInt`, `String`, `console`, ...) -> the global object property name. */
  globalObjectValueName(name: string): string | undefined {
    switch (name) {
      case "Array":
      case "Object":
      case "Promise":
      case "Headers":
      case "AbortController":
      case "AbortSignal":
      case "Map":
      case "Set":
      case "WeakMap":
      case "WeakSet":
      case "String":
      case "Number":
      case "Boolean":
      case "Symbol":
      case "Date":
      case "Function":
      case "Error":
      case "TypeError":
      case "RangeError":
      case "SyntaxError":
      case "ReferenceError":
      case "EvalError":
      case "URIError":
      case "AggregateError":
      case "Math":
      case "JSON":
      case "console":
      case "parseInt":
      case "parseFloat":
      case "isNaN":
      case "isFinite":
      case "fetch":
        return name;
      default: return TYPED_ARRAY_ELEMS.has(name) || name === "ArrayBuffer" || name === "SharedArrayBuffer"
        ? name : undefined;
    }
  }

  /** Bind a destructuring pattern to the value in local `src`. Handles array
   *  patterns (by index), object patterns (by property name), and nesting.
   *  Rest elements (...) and default values are rejected loudly for now. */
  /** Returns a local holding `value` unless it is undefined, in which case the
   *  default expression `def` is evaluated and used (JS destructuring default
   *  applies only on undefined, not null). */
  applyDefault(ctx: FnCtx, value: number, def: ts.Expression): number {
    const res = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Copy", dst: res, src: value });
    const isUndef = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "UnOp", dst: isUndef, op: "isundef", operand: value });
    const body = this.captureBody(ctx, () => {
      const d = this.lowerExpr(ctx, def);
      ctx.body.push({ kind: "Copy", dst: res, src: d });
    });
    ctx.body.push({ kind: "If", cond: isUndef, thenBody: body, elseBody: [] });
    return res;
  }

  /** The source of an array pattern (`const [a, b] = e`, `[a, b] = e`) when `e` is
   *  not array-like: a Map or Set is materialized to an array (their iterators have
   *  no `return`, so nothing observable differs); a class iterable, a generator, an
   *  iterator object or an object with [Symbol.iterator] is stepped by the
   *  protocol. undefined for an array, a tuple, a string or `any`: read by index. */
  private iterablePatternSource(ctx: FnCtx, init: ts.Expression): { array: number; source: number } | { drv: IterDriver } | undefined {
    const rk = this.builtinReceiverKind(init);
    if (rk === "array" || rk === "string") return undefined;
    let t: ts.Type;
    try { t = this.checker.getTypeAtLocation(init); } catch { return undefined; }
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike)) return undefined;
    const arrayLike = (ty: ts.Type): boolean => this.checker.isArrayLikeType(ty) || !!(ty.flags & ts.TypeFlags.StringLike);
    if (arrayLike(t) || (t.isUnion() && t.types.every(arrayLike))) return undefined;
    if (rk === "map" || rk === "set") {
      const recv = this.lowerExpr(ctx, init);
      const it = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "CallBuiltin", dst: it, builtin: rk === "map" ? "map.entries" : "set.values", recv, args: [] });
      const array = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "CallBuiltinStatic", dst: array, builtin: "array.from", args: [it] });
      return { array, source: recv };
    }
    const drv = this.resolveIterator(ctx, init);
    return drv === undefined ? undefined : { drv };
  }
  /** The elements of a binding pattern as the protocol binder takes them. */
  private bindingPatternElements(ctx: FnCtx, pat: ts.ArrayBindingPattern): IterPatternElement[] {
    return pat.elements.map((el): IterPatternElement => ({
      node: el,
      omitted: ts.isOmittedExpression(el),
      rest: !ts.isOmittedExpression(el) && el.dotDotDotToken !== undefined,
      bind: (v: number) => {
        if (ts.isOmittedExpression(el)) return;
        this.lowerBindingPattern(ctx, el.name, el.initializer ? this.applyDefault(ctx, v, el.initializer) : v);
      },
    }));
  }
  /** A pattern bound from a local rather than an expression (nested in another
   *  pattern, a parameter, a for-of variable): when its declared type is not
   *  array-like, the value is iterated through the runtime's GetIterator. */
  private dynamicPatternDriver(ctx: FnCtx, pat: ts.ArrayBindingPattern, src: number): IterDriver | undefined {
    let t: ts.Type;
    try { t = this.checker.getTypeAtLocation(pat.parent); } catch { return undefined; }
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike)) return undefined;
    const arrayLike = (ty: ts.Type): boolean => this.checker.isArrayLikeType(ty) || !!(ty.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
    if (arrayLike(t) || (t.isUnion() && t.types.every(arrayLike))) return undefined;
    return this.runtimeIterDriver(ctx, src, false);
  }
  /** The protocol over an iterator the runtime acquires (ts_iter_acquire): next by
   *  the generic step, IteratorClose by the generic close. */
  private runtimeIterDriver(ctx: FnCtx, src: number, async: boolean): IterDriver {
    const itLocal = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltinStatic", dst: itLocal, builtin: `iter.acquire:${async ? 1 : 0}`, args: [src] });
    const step = (sent: number): number => {
      const rr = this.emitIterNext(ctx, itLocal, sent);
      if (!async) return rr;
      const r = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Await", dst: r, operand: rr });
      return r;
    };
    const returnCall = (): void => {
      const rr = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "CallBuiltin", dst: rr, builtin: `iter.close:${this.internName("return")}`, recv: itLocal, args: [] });
      if (async) {
        const undefV = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: undefV, value: { kind: "Undef" } });
        const called = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "BinOp", dst: called, op: "!==", lhs: rr, rhs: undefV });
        const thenBody = this.captureBody(ctx, () => {
          const awaited = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Await", dst: awaited, operand: rr });
        });
        ctx.body.push({ kind: "If", cond: called, thenBody, elseBody: [] });
      }
    };
    return { itLocal, srcLocal: src, isAsync: async, step, returnCall };
  }
  /** Bind an array pattern from an iterator: one step per element (a hole takes one
   *  too, a step past the end leaves undefined), the rest element collecting what
   *  remains, and IteratorClose when the pattern ends before the iterator does. */
  private lowerArrayPatternByProtocol(ctx: FnCtx, drv: IterDriver, elements: IterPatternElement[]): void {
    const doneField = this.internField("done");
    const valueField = this.internField("value");
    const undef0 = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: undef0, value: { kind: "Undef" } });
    const falseC = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst: falseC, value: { kind: "Bool", value: false } });
    const trueC = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst: trueC, value: { kind: "Bool", value: true } });
    const done = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Copy", dst: done, src: falseC });
    const notDone = (): number => {
      const nd = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "UnOp", dst: nd, op: "!", operand: done });
      return nd;
    };
    // r = it.next(); if (r.done) done = true; else <onValue>(r.value)
    const stepOnce = (onValue: ((value: number) => void) | undefined): void => {
      const r = drv.step(undef0);
      const d = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadField", dst: d, obj: r, field: doneField });
      const more = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "UnOp", dst: more, op: "!", operand: d });
      const thenBody = this.captureBody(ctx, () => {
        if (onValue !== undefined) {
          const value = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadField", dst: value, obj: r, field: valueField });
          onValue(value);
        }
      });
      const elseBody = this.captureBody(ctx, () => { ctx.body.push({ kind: "Copy", dst: done, src: trueC }); });
      ctx.body.push({ kind: "If", cond: more, thenBody, elseBody });
    };
    for (const el of elements) {
      if (el.rest) {
        const site = this.site++;
        this.recordSite(site, "array", this.inLoop(el.node) ? "many" : "once", false, el.node);
        const arr = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "AllocArray", dst: arr, elemType: 0, site });
        let cond = -1;
        const condBody = this.captureBody(ctx, () => { cond = notDone(); });
        const body = this.captureLoopBody(ctx, "while", () => {
          stepOnce((value) => { ctx.body.push({ kind: "ArrayPush", arr, src: value }); });
        });
        ctx.body.push({ kind: "Loop", cond, condBody, body });
        el.bind(arr);
        continue;
      }
      const v = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: v, value: { kind: "Undef" } });
      const pending = notDone();
      const thenBody = this.captureBody(ctx, () => {
        stepOnce(el.omitted ? undefined : (value) => { ctx.body.push({ kind: "Copy", dst: v, src: value }); });
      });
      ctx.body.push({ kind: "If", cond: pending, thenBody, elseBody: [] });
      if (!el.omitted) el.bind(v);
    }
    if (drv.returnCall) {
      const open = notDone();
      const thenBody = this.captureBody(ctx, () => { drv.returnCall!(); });
      ctx.body.push({ kind: "If", cond: open, thenBody, elseBody: [] });
    }
  }

  lowerBindingPattern(ctx: FnCtx, pat: ts.BindingName, src: number): void {
    if (ts.isIdentifier(pat)) {
      const sym = this.symbolOf(pat);
      if (this.isScriptGlobalVarSymbol(sym, pat.text)) {
        this.storeGlobalObjectProperty(ctx, pat.text, src);
      } else if (sym && this.hasCaptured(ctx, sym)) {
        this.storeCaptured(ctx, sym, src);
      } else {
        const lid = sym ? this.ensureLocal(ctx, sym, this.refKindOf(pat), pat.text)
                        : this.newLocal(ctx, this.refKindOf(pat), pat.text);
        ctx.body.push({ kind: "Copy", dst: lid, src });
      }
      return;
    }
    if (ts.isArrayBindingPattern(pat)) {
      const drv = this.dynamicPatternDriver(ctx, pat, src);
      if (drv !== undefined) { this.lowerArrayPatternByProtocol(ctx, drv, this.bindingPatternElements(ctx, pat)); return; }
      pat.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el)) return; // hole: const [, b] = ...
        if (el.dotDotDotToken) {
          // rest: bind the remaining elements src.slice(i) as an array.
          const startIdx = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst: startIdx, value: { kind: "Num", value: i } });
          const restArr = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "ArraySlice", dst: restArr, arr: src, start: startIdx });
          this.lowerBindingPattern(ctx, el.name, restArr);
          return;
        }
        // element value = src[i]
        const idx = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst: idx, value: { kind: "Num", value: i } });
        const elemVal = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadIndex", dst: elemVal, arr: src, index: idx });
        const bound = el.initializer ? this.applyDefault(ctx, elemVal, el.initializer) : elemVal;
        this.lowerBindingPattern(ctx, el.name, bound);
      });
      return;
    }
    if (ts.isObjectBindingPattern(pat)) {
      const boundKeys: string[] = [];
      for (const el of pat.elements) {
        this.noteMethodEscape(ctx, el);
        if (el.dotDotDotToken) {
          // rest: {a, ...others} -> others = copy of src minus already-bound keys.
          const restObj = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "ObjectRest", dst: restObj, src, exclude: boundKeys.map((k) => this.internField(k)) });
          this.lowerBindingPattern(ctx, el.name, restObj);
          continue;
        }
        const propVal = this.newLocal(ctx, "reference");
        if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) {
          // `{[k]: name}` — evaluate the key and read dynamically (the property is
          // determined at runtime; handles object and array, string and numeric
          // keys). NOTE: a runtime key can't be statically excluded from a rest.
          const keyL = this.lowerExpr(ctx, el.propertyName.expression);
          ctx.body.push({ kind: "LoadFieldDynamic", dst: propVal, obj: src, key: keyL });
        } else {
          // `{prop: name}` / `{"prop": name}` / `{0: name}` / shorthand `{name}`.
          const propName = el.propertyName
            ? ((ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) || ts.isNumericLiteral(el.propertyName)) ? el.propertyName.text : undefined)
            : (ts.isIdentifier(el.name) ? el.name.text : undefined);
          if (propName === undefined) { this.unsupported(el, "unsupported property name in destructuring"); continue; }
          boundKeys.push(propName);
          ctx.body.push({ kind: "LoadField", dst: propVal, obj: src, field: this.internField(propName) });
        }
        const bound = el.initializer ? this.applyDefault(ctx, propVal, el.initializer) : propVal;
        this.lowerBindingPattern(ctx, el.name, bound);
      }
      return;
    }
    this.unsupported(pat as ts.Node, `binding pattern ${ts.SyntaxKind[(pat as unknown as ts.Node).kind]}`);
  }

  /** Detect awaits NOT in a directly-supported top-level position. Supported:
   *  `await e;`, `const x = await e;`, `x = await e;`, `return await e;`. Any
   *  other await (inside if/loop/try, or as a sub-expression like `f(await e)`
   *  or `a + await e`) is "nested" and rejected in v1. */
  /** Returns a rejection reason if the body has an await/yield inside a try in a
   *  shape the coroutine EH builder does not support yet, or undefined if OK.
   *  Supported: a single try { ...suspend... } catch (e) { ...no suspend... } with
   *  no finally and no nested coroutine-try. */
  unsupportedSuspendInTry(body: ts.Node): string | undefined {
    const hasSuspend = (n: ts.Node): boolean => {
      let f = false;
      const v = (x: ts.Node) => {
        if (f) return;
        if (ts.isAwaitExpression(x) || ts.isYieldExpression(x)) { f = true; return; }
        if (ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || ts.isArrowFunction(x)) return;
        ts.forEachChild(x, v);
      };
      v(n);
      return f;
    };
    let reason: string | undefined;
    const walkTry = (t: ts.TryStatement) => {
      if (reason) return;
      const tryHasSuspend = hasSuspend(t.tryBlock);
      const catchHasSuspend = t.catchClause ? hasSuspend(t.catchClause.block) : false;
      const finallyHasSuspend = t.finallyBlock ? hasSuspend(t.finallyBlock) : false;
      const anySuspend = tryHasSuspend || catchHasSuspend || finallyHasSuspend;
      if (!anySuspend) return; // suspension-free try uses plain setjmp EH; fine
      // try/catch/finally with a suspension is supported by the coroutine EH
      // builder (catch & finally bodies may themselves suspend). A try with a
      // finally but NO catch is also supported (try/finally). The remaining
      // unsupported case: a return/break/continue escaping a try/catch that has a
      // finally with a suspension (finally-through-unwind) — but that is gated by
      // the separate blockExitsControl check for finally. Nothing to reject here.
    };
    const walk = (n: ts.Node) => {
      if (reason) return;
      if (ts.isTryStatement(n)) walkTry(n);
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
      ts.forEachChild(n, walk);
    };
    walk(body);
    return reason;
  }

  /** True if any await/yield appears inside a try/catch/finally block (the one
   *  construct the state-machine builder can't cross, since setjmp/longjmp
   *  unwinding across a suspension is unsound). */
  hasSuspendInTry(body: ts.Node): boolean {
    let found = false;
    const hasSuspend = (n: ts.Node): boolean => {
      let f = false;
      const v = (x: ts.Node) => {
        if (f) return;
        if (ts.isAwaitExpression(x) || ts.isYieldExpression(x)) { f = true; return; }
        if (ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || ts.isArrowFunction(x)) return;
        ts.forEachChild(x, v);
      };
      v(n);
      return f;
    };
    const walk = (n: ts.Node) => {
      if (found) return;
      if (ts.isTryStatement(n) && hasSuspend(n)) { found = true; return; }
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
      ts.forEachChild(n, walk);
    };
    walk(body);
    return found;
  }

  hasNestedAwait(body: ts.Node): boolean {
    let nested = false;
    const isAwait = (n: ts.Node | undefined): n is ts.AwaitExpression =>
      !!n && ts.isAwaitExpression(n);
    const stmts = ts.isBlock(body) ? body.statements : [];
    const scanStray = (n: ts.Node) => {
      const v = (x: ts.Node) => {
        if (nested) return;
        if (ts.isAwaitExpression(x)) { nested = true; return; }
        if (ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || ts.isArrowFunction(x)) return;
        ts.forEachChild(x, v);
      };
      v(n);
    };
    for (const st of stmts) {
      if (ts.isExpressionStatement(st)) {
        const e = st.expression;
        if (isAwait(e)) { scanStray(e.expression); continue; }
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && isAwait(e.right)) {
          scanStray(e.left); scanStray(e.right.expression); continue;
        }
        scanStray(e);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (d.initializer && isAwait(d.initializer)) scanStray(d.initializer.expression);
          else if (d.initializer) scanStray(d.initializer);
        }
      } else if (ts.isReturnStatement(st)) {
        if (st.expression && isAwait(st.expression)) scanStray(st.expression.expression);
        else if (st.expression) scanStray(st.expression);
      } else {
        scanStray(st);
      }
      if (nested) break;
    }
    return nested;
  }

  /** True if the expression's static type is a Generator / Iterator /
   *  IterableIterator (so .next() means the generator protocol). */
  isGeneratorType(expr: ts.Expression): boolean {
    try {
      const t = this.checker.getTypeAtLocation(expr);
      const tn = this.checker.typeToString(t);
      // Only a Generator is one of our coroutines: an Iterator / IterableIterator may be an array,
      // Map or Set iterator or a user's object (vue casts an array iterator to IterableIterator and
      // wraps its next); those step through the dynamic protocol, which also drives a coroutine.
      if (/^Generator\b/.test(tn)) return true;
      // A type whose string merely CONTAINS "Generator<" — e.g. an object/class
      // with a `[Symbol.iterator](): Generator<...>` member — is an ITERABLE, not a
      // generator itself; it must own a `next` to be driven via the generator
      // builtin (a real generator has next/return/throw). Otherwise it would be
      // wrongly stepped with ts_gen_next on the object instead of its iterator.
      return /\bGenerator</.test(tn) && !!(t.getProperty && t.getProperty("next"));
    } catch { return false; }
  }

  isAsyncGeneratorType(expr: ts.Expression): boolean {
    try {
      const t = this.checker.getTypeAtLocation(expr);
      const tn = this.checker.typeToString(t);
      if (/^AsyncGenerator\b/.test(tn)) return true;
      return /\bAsyncGenerator</.test(tn) && !!(t.getProperty && t.getProperty("next"));
    } catch { return false; }
  }

  /** True if the expression's static type exposes a callable `next` member
   *  (the core of the iterator protocol). Used to drive arbitrary iterators via
   *  a dynamic .next() call. Excludes our own Generator types (handled faster by
   *  the builtin path) and Promise-returning next() (async — see below). */
  isIteratorType(expr: ts.Expression): boolean {
    try {
      const t = this.checker.getTypeAtLocation(expr);
      const next = t.getProperty && t.getProperty("next");
      if (!next) return false;
      const nt = this.checker.getTypeOfSymbolAtLocation(next, expr);
      const sigs = nt.getCallSignatures ? nt.getCallSignatures() : [];
      if (!sigs || sigs.length === 0) return false;
      // async iterator if next() returns a Promise
      const ret = this.checker.typeToString(sigs[0].getReturnType());
      return !/^Promise\b/.test(ret);
    } catch { return false; }
  }

  isAsyncIteratorType(expr: ts.Expression): boolean {
    try {
      const t = this.checker.getTypeAtLocation(expr);
      const next = t.getProperty && t.getProperty("next");
      if (!next) return false;
      const nt = this.checker.getTypeOfSymbolAtLocation(next, expr);
      const sigs = nt.getCallSignatures ? nt.getCallSignatures() : [];
      if (!sigs || sigs.length === 0) return false;
      const ret = this.checker.typeToString(sigs[0].getReturnType());
      return /^Promise\b/.test(ret);
    } catch { return false; }
  }

  /** Emit a dynamic `recv.next(arg)` method call (prototype-chain dispatch),
   *  returning the result local holding the {value,done} object. */
  emitIterNext(ctx: FnCtx, recv: number, arg: number): number {
    // Step a generic iterator via the runtime helper, which mirrors the dynamic
    // `.next()` dispatch (field-key then method-key lookup, passing the interned
    // "next" method id) AND falls back to generator.next when the iterator is one of
    // our generator coroutine objects (returned by a generator `[Symbol.iterator]()`,
    // which has no `next` property). This makes `for...of`/`yield*` over a generator
    // iterator work like spread, without regressing class iterators whose `next` is a
    // prototype method.
    const dst = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltin", dst, builtin: `iter.step:${this.internName("next")}`, recv, args: [arg] });
    return dst;
  }

  /** Unified iteration driver setup. Classifies the iterable/iterator, acquires
   *  the iterator object (calling [Symbol.iterator]/[Symbol.asyncIterator] when the
   *  expression is an iterable class), and returns a `step` closure that emits one
   *  `r = [await] it.next(sent)` and returns the result local holding {value,done}.
   *
   *  This is the SINGLE place that knows how to drive any iteration source, so
   *  for-of / for-await / yield* share identical semantics and any future change
   *  (e.g. calling it.return() on early exit) lands in one location.
   *
   *  `forceAsync` requests await-driven stepping even for a sync source (used by
   *  for-await / yield* inside async contexts). Returns undefined if the source is
   *  not a recognized iterable/iterator (caller decides: array fallback or reject). */
  resolveIterator(
    ctx: FnCtx, expr: ts.Expression, opts: { forceAsync?: boolean } = {}
  ): IterDriver | undefined {
    const isOurGen = this.isGeneratorType(expr);
    const isOurAsyncGen = this.isAsyncGeneratorType(expr);
    const ofClass = this.classOfExpr(expr);
    const hasSyncIter = ofClass !== undefined && this.classHasMethod(ofClass, "@@iterator");
    const hasAsyncIter = ofClass !== undefined && this.classHasMethod(ofClass, "@@asyncIterator");
    const isIterable = hasSyncIter || hasAsyncIter;
    const isIterator = this.isIteratorType(expr) || this.isAsyncIteratorType(expr);
    // A non-class object exposing [Symbol.iterator] (e.g. an object literal with a
    // computed `[Symbol.iterator]()` member). Acquired at runtime via the symbol
    // key, then stepped with the dynamic .next() protocol.
    const plainObject = !isOurGen && !isOurAsyncGen && !isIterable && !isIterator;
    const objSymSync = plainObject && this.typeHasSymbolIterator(expr, "iterator");
    const objSymAsync = plainObject && this.typeHasSymbolIterator(expr, "asyncIterator");
    // for-await takes [Symbol.asyncIterator] when there is one; a sync loop needs [Symbol.iterator]
    const useAsyncSym = objSymAsync && (!!opts.forceAsync || !objSymSync);
    const objSymIterable = useAsyncSym || objSymSync;
    if (!isOurGen && !isOurAsyncGen && !isIterable && !isIterator && !objSymIterable) return undefined;

    const isAsync = !!opts.forceAsync || isOurAsyncGen || hasAsyncIter || useAsyncSym || this.isAsyncIteratorType(expr);
    const src = this.lowerExpr(ctx, expr);

    // If the iterable's [Symbol.iterator]/[Symbol.asyncIterator] method is itself a
    // generator (`*[Symbol.iterator]()`), calling it returns one of OUR generator
    // objects. Its .next() is then the generator.next builtin, not a prototype
    // method dispatch — so treat the obtained iterator like our own generator.
    const iterMethodName = hasAsyncIter ? "@@asyncIterator" : "@@iterator";
    const iterIsGenerator = isIterable && ofClass !== undefined &&
      this.classMethodIsGenerator(ofClass, iterMethodName);

    // acquire the iterator: for an iterable class, call its [Symbol.*iterator]().
    let itLocal = src;
    if (isIterable) {
      itLocal = this.newLocal(ctx, "reference");
      ctx.body.push({
        kind: "Call", dst: itLocal, recv: src, args: [],
        callee: { kind: "Method", recvClass: ofClass!, method: this.internName(iterMethodName), recvStable: false },
      });
    } else if (objSymIterable) {
      // it = GetIterator(obj) at run time: the symbol-keyed method called on the
      // object, or the runtime's iterator when the value turns out to be an array,
      // a string or a collection (a parameter typed Iterable<T> takes any of them).
      itLocal = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "CallBuiltinStatic", dst: itLocal, builtin: `iter.acquire:${useAsyncSym ? 1 : 0}`, args: [src] });
    }

    const useBuiltin = isOurGen || isOurAsyncGen || iterIsGenerator;
    // a sync generator stepped by a driver: generator.step reuses the coroutine's result object (the
    // drivers read done and value at once and never keep it; gen.next() in the program stays fresh)
    const nextBuiltin = (isOurAsyncGen || (iterIsGenerator && isAsync)) ? "asyncgen.next" : "generator.step";
    const step = (sentLocal: number): number => {
      const r = this.newLocal(ctx, "reference");
      if (useBuiltin) {
        if (isAsync) {
          const prom = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltin", dst: prom, builtin: nextBuiltin, recv: itLocal, args: [sentLocal] });
          ctx.body.push({ kind: "Await", dst: r, operand: prom });
        } else {
          ctx.body.push({ kind: "CallBuiltin", dst: r, builtin: nextBuiltin, recv: itLocal, args: [sentLocal] });
        }
      } else {
        const rr = this.emitIterNext(ctx, itLocal, sentLocal);
        if (isAsync) ctx.body.push({ kind: "Await", dst: r, operand: rr });
        else ctx.body.push({ kind: "Copy", dst: r, src: rr });
      }
      return r;
    };

    // Forward an exception into the iterator (it.throw(e)) — used by yield* when
    // the delegating generator is thrown into. For our generators this is the
    // generator.throw / asyncgen.throw builtin; for a custom iterator with a
    // `throw` method it is a dynamic call. Returns the {value,done} result local.
    // undefined if the iterator cannot accept a throw (caller rethrows).
    const throwBuiltin = isOurAsyncGen ? "asyncgen.throw" : "generator.throw";
    const customHasThrow = !useBuiltin &&
      ((ofClass !== undefined && this.classHasMethod(ofClass, "throw")) || this.typeHasCallable(expr, "throw"));
    let throwStep: ((excLocal: number) => number) | undefined;
    if (useBuiltin || customHasThrow) {
      throwStep = (excLocal: number): number => {
        const r = this.newLocal(ctx, "reference");
        if (useBuiltin) {
          if (isAsync) {
            const prom = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "CallBuiltin", dst: prom, builtin: throwBuiltin, recv: itLocal, args: [excLocal] });
            ctx.body.push({ kind: "Await", dst: r, operand: prom });
          } else {
            ctx.body.push({ kind: "CallBuiltin", dst: r, builtin: throwBuiltin, recv: itLocal, args: [excLocal] });
          }
        } else {
          const rr = this.newLocal(ctx, "reference");
          ctx.body.push({
            kind: "Call", dst: rr, recv: itLocal, args: [excLocal],
            callee: { kind: "Method", recvClass: 0xffffffff, method: this.internName("throw"), recvStable: false },
          });
          if (isAsync) ctx.body.push({ kind: "Await", dst: r, operand: rr });
          else ctx.body.push({ kind: "Copy", dst: r, src: rr });
        }
        return r;
      };
    }

    // Optional iterator-close. Our generator wrappers need an explicit injected
    // return completion too; merely stopping pulls leaves their finally blocks
    // suspended forever.
    let returnCall: (() => void) | undefined;
    if (useBuiltin) {
      returnCall = () => {
        const undefA = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "Const", dst: undefA, value: { kind: "Undef" } });
        const rr = this.newLocal(ctx, "reference");
        const returnBuiltin = nextBuiltin === "asyncgen.next" ? "asyncgen.return" : "generator.return";
        ctx.body.push({ kind: "CallBuiltin", dst: rr, builtin: returnBuiltin, recv: itLocal, args: [undefA] });
        if (isAsync) {
          const awaited = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Await", dst: awaited, operand: rr });
        }
      };
    } else if (this.iteratorMayHaveReturn(expr, isIterable || objSymIterable, hasAsyncIter || useAsyncSym)) {
      // IteratorClose: the iterator's `return`, looked up at run time (a class
      // iterator's prototype method, an own function, nothing), called without an
      // argument; a generator object standing in as an iterator is returned from.
      // AsyncIteratorClose awaits the result only when there was a method to call.
      returnCall = () => {
        const rr = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltin", dst: rr, builtin: `iter.close:${this.internName("return")}`, recv: itLocal, args: [] });
        if (isAsync) {
          const undefV = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Const", dst: undefV, value: { kind: "Undef" } });
          const called = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "BinOp", dst: called, op: "!==", lhs: rr, rhs: undefV });
          const thenBody = this.captureBody(ctx, () => {
            const awaited = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "Await", dst: awaited, operand: rr });
          });
          ctx.body.push({ kind: "If", cond: called, thenBody, elseBody: [] });
        }
      };
    }
    return { itLocal, srcLocal: src, isAsync, step, throwStep, returnCall };
  }

  /** True if the expression's static type has a callable member `name`. */
  private typeHasCallable(expr: ts.Expression, name: string): boolean {
    try {
      const t = this.checker.getTypeAtLocation(expr);
      const m = t.getProperty && t.getProperty(name);
      if (!m) return false;
      const mt = this.checker.getTypeOfSymbolAtLocation(m, expr);
      const sigs = mt.getCallSignatures ? mt.getCallSignatures() : [];
      return !!sigs && sigs.length > 0;
    } catch { return false; }
  }
  /** Does the expression's static type expose a [Symbol.iterator] method (i.e. it
   *  is a non-array, non-class iterable object such as an object literal with a
   *  computed `[Symbol.iterator]()` member)? TS names that member `__@iterator@N`.
   *  Excludes arrays/strings (handled by the index loop) and our generators. */
  private typeHasSymbolIterator(expr: ts.Expression, which: "iterator" | "asyncIterator" = "iterator"): boolean {
    if (which === "iterator" && (this.builtinReceiverKind(expr) === "array" || this.builtinReceiverKind(expr) === "string")) return false;
    try {
      const t = this.checker.getTypeAtLocation(expr);
      const props = this.checker.getPropertiesOfType(t);
      return props.some((p) => String(p.escapedName).startsWith(`__@${which}@`) || String(p.escapedName) === `__@${which}`);
    } catch { return false; }
  }
  /** May the iterator a loop drives have a `return` method (IteratorClose calls it
   *  on an abrupt exit)? The iterator's static type decides: the result type of the
   *  iterable's [Symbol.iterator]/[Symbol.asyncIterator] method, or the expression's
   *  own type for an iterator object. `any`, a union with such a member, or a type
   *  declaring `return` (lib's `Iterator<T>` declares it optional) may; an object
   *  literal or class type without one does not, and keeps the plain loop. */
  private iteratorMayHaveReturn(expr: ts.Expression, viaIterable: boolean, async: boolean): boolean {
    if (this.isBuiltinIteratorCall(expr)) return false;
    try {
      let t: ts.Type = this.checker.getTypeAtLocation(expr);
      if (viaIterable) {
        const prefix = async ? "__@asyncIterator" : "__@iterator";
        const m = this.checker.getPropertiesOfType(t).find((p) => String(p.escapedName).startsWith(prefix));
        if (!m) return true;
        const sigs = this.checker.getTypeOfSymbolAtLocation(m, expr).getCallSignatures();
        if (sigs.length === 0) return true;
        t = sigs[0].getReturnType();
      }
      const may = (ty: ts.Type): boolean => {
        if (ty.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
        if (ty.isUnion() || ty.isIntersection()) return ty.types.some(may);
        if (this.isBuiltinIteratorType(ty)) return false;
        return ty.getProperty("return") !== undefined;
      };
      return may(t);
    } catch { return true; }
  }
  /** The runtime's own iterators (an array's, string's, Map's or Set's keys/values/
   *  entries, a string's matchAll) have no `return`: a loop over one needs no
   *  IteratorClose, so its hot path stays a plain loop. By the call shape ... */
  private isBuiltinIteratorCall(expr: ts.Expression): boolean {
    let e: ts.Expression = expr;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
    const name = e.expression.name.text;
    if (name !== "keys" && name !== "values" && name !== "entries" && name !== "matchAll") return false;
    const rk = this.builtinReceiverKind(e.expression.expression);
    return rk === "array" || rk === "string" || rk === "map" || rk === "set" || rk === "headers";
  }
  /** ... and by the lib's iterator interface names (ArrayIterator, MapIterator, ...). */
  private isBuiltinIteratorType(ty: ts.Type): boolean {
    const sym = ty.getSymbol ? ty.getSymbol() : undefined;
    if (!sym) return false;
    const name = String(sym.escapedName);
    if (name !== "ArrayIterator" && name !== "MapIterator" && name !== "SetIterator" && name !== "StringIterator" && name !== "RegExpStringIterator") return false;
    return this.isBuiltinSymbol(sym);
  }

  /** Collect the closure-captured identifier symbols declared by a loop binding
   *  name (a plain identifier or a destructuring pattern). Each needs a FRESH
   *  per-iteration cell so closures created during iteration N observe iteration
   *  N's value (JS per-iteration binding semantics). */
  private collectCapturedBindingSyms(name: ts.BindingName): ts.Symbol[] {
    const out: ts.Symbol[] = [];
    const walk = (n: ts.BindingName) => {
      if (ts.isIdentifier(n)) {
        const s = this.symbolOf(n);
        if (s && this.cellBindings.has(s)) out.push(s);
      } else {
        for (const el of n.elements) {
          if (ts.isBindingElement(el)) walk(el.name);
        }
      }
    };
    walk(name);
    return out;
  }

  /** Set up per-iteration cells for the captured variables a loop binding `name`
   *  declares (identifier or destructuring). Overrides ctx.cellAccess to point at
   *  the fresh cells; returns the records so the caller can (a) re-allocate the
   *  cells at the top of each iteration via `perSite`, and (b) restore cellAccess
   *  after the loop. */
  private setupForOfCaptureCells(
    ctx: FnCtx, name: ts.BindingName, declNode: ts.Node,
  ): { sym: ts.Symbol; cell: number; perSite: number; saved: number | undefined }[] {
    const cells: { sym: ts.Symbol; cell: number; perSite: number; saved: number | undefined }[] = [];
    for (const sym of this.collectCapturedBindingSyms(name)) {
      const cell = this.newLocal(ctx, "reference", `cell_${(sym as any).name ?? "v"}`, this.bindingIdOf(sym));
      const perSite = this.site++;
      this.labels[perSite] = `cell:${(sym as any).name ?? "v"}@forof`;
      this.recordSite(perSite, "cell", "many", true, declNode, true);
      cells.push({ sym, cell, perSite, saved: ctx.cellAccess.get(sym) });
      ctx.cellAccess.set(sym, cell);
    }
    return cells;
  }

  /** Captured let/const bindings whose fresh-per-iteration cell THIS loop owns:
   *  those declared lexically in the loop `body`, not crossing into a nested
   *  function (its own scope) nor a nested loop (which reallocates its own body
   *  cells). Per JS §14.7.4 CreatePerIterationEnvironment, every iteration is a
   *  fresh lexical environment for the WHOLE body — not just the loop head — so a
   *  `const`/`let` declared in the body and captured by a closure must get a
   *  fresh cell each iteration, or escaping closures from different iterations
   *  alias one cell (observed as a self-referential closure -> infinite
   *  recursion when the body does `const prev = acc; acc = () => prev(...)`). */
  private collectLoopBodyCapturedSyms(body: ts.Statement): ts.Symbol[] {
    const out: ts.Symbol[] = [];
    const seen = new Set<ts.Symbol>();
    const visit = (n: ts.Node) => {
      if (isFunctionLike(n)) return;                 // nested fn: own per-call scope
      if (n !== body && isLoopStatement(n)) return;  // nested loop: owns its body cells
      if (ts.isVariableDeclaration(n) && ts.isVariableDeclarationList(n.parent) &&
          (n.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
        for (const s of this.collectCapturedBindingSyms(n.name)) {
          if (!seen.has(s)) { seen.add(s); out.push(s); }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return out;
  }

  /** At the top of a loop-body iteration, allocate a FRESH cell for each captured
   *  binding this loop's body declares (see collectLoopBodyCapturedSyms). Reuses
   *  the binding's existing cell LOCAL (the prologue-allocated one, already in
   *  cellAccess), rebinding it to a fresh object each iteration; closures created
   *  in the iteration capture that iteration's object. Emitted once into the
   *  captured loop-body template (which the Loop op replays each iteration). */
  private emitPerIterationBodyCells(ctx: FnCtx, body: ts.Statement): void {
    for (const sym of this.collectLoopBodyCapturedSyms(body)) {
      const cellLocal = ctx.cellAccess.get(sym);
      if (cellLocal === undefined) continue;   // no cell (non-captured) — nothing to refresh
      const perSite = this.site++;
      this.labels[perSite] = `cell:${(sym as any).name ?? "v"}@loopbody`;
      this.recordSite(perSite, "cell", "many", true, body, true);
      ctx.body.push({ kind: "AllocObject", dst: cellLocal, typeId: 0, site: perSite, classId: this.cellClassId });
    }
  }

  /** Bind a for-of/for-await loop variable from its declaration (or a fresh
   *  local for non-simple binding). */
  private bindForVar(ctx: FnCtx, init: ts.ForInitializer): number {
    if (ts.isVariableDeclarationList(init) && init.declarations.length && ts.isIdentifier(init.declarations[0].name)) {
      const sym = this.symbolOf(init.declarations[0].name);
      return sym ? this.ensureLocal(ctx, sym, "reference", init.declarations[0].name.text)
                 : this.newLocal(ctx, "reference");
    }
    return this.newLocal(ctx, "reference");
  }

  private emitIndexStep(ctx: FnCtx, idx: number, stepValue: number): void {
    const step = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst: step, value: { kind: "Num", value: stepValue } });
    const next = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "BinOp", dst: next, op: "+", lhs: idx, rhs: step });
    ctx.body.push({ kind: "Copy", dst: idx, src: next });
  }

  private emitStringIteratorElement(ctx: FnCtx, str: number, idx: number, dst: number): number {
    const cp = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "CallBuiltin", dst: cp, builtin: "string.codePointAt", recv: str, args: [idx] });
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "string.fromCodePoint", args: [cp] });
    return cp;
  }

  private emitStringIteratorAdvance(ctx: FnCtx, idx: number, cp: number): void {
    const maxBmp = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst: maxBmp, value: { kind: "Num", value: 0xffff } });
    const isAstral = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "BinOp", dst: isAstral, op: ">", lhs: cp, rhs: maxBmp });
    const thenBody = this.captureBody(ctx, () => { this.emitIndexStep(ctx, idx, 2); });
    const elseBody = this.captureBody(ctx, () => { this.emitIndexStep(ctx, idx, 1); });
    ctx.body.push({ kind: "If", cond: isAstral, thenBody, elseBody });
  }

  /** Lower a for-of as an index loop over an array (or string). Handles both a
   *  simple identifier loop variable and a destructuring pattern (e.g.
   *  `for (const [k,v] of map.entries())`). `iterIsString` selects UTF-16
   *  code-point iteration for string iteration. */
  private lowerArrayIndexForOf(
    ctx: FnCtx, init: ts.ForInitializer, statement: ts.Statement, arr: number, iterIsString: boolean,
    mode: "values" | "keys" | "entries" = "values",
  ): void {
    const idx = this.newLocal(ctx, "primitive");
    const zero = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst: zero, value: { kind: "Num", value: 0 } });
    ctx.body.push({ kind: "Copy", dst: idx, src: zero });
    const varLocal = this.newLocal(ctx, mode === "keys" ? "primitive" : "reference", "elem");
    const decl = ts.isVariableDeclarationList(init) ? init.declarations[0] : undefined;
    // Lexical loop bindings are fresh each iteration; var retains its shared cell.
    const captureCells = decl && (init.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
      ? this.setupForOfCaptureCells(ctx, decl.name, decl) : [];
    let condLocal = -1;
    const condBody = this.captureBody(ctx, () => {
      const len = this.newLocal(ctx, "primitive");
      if (iterIsString) ctx.body.push({ kind: "StringLen", dst: len, src: arr });
      else ctx.body.push({ kind: "ArrayLen", dst: len, arr });
      condLocal = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "BinOp", dst: condLocal, op: "<", lhs: idx, rhs: len });
    });
    const bodyB = this.captureLoopBody(ctx, "forof", () => {
      let cp = -1;
      let keyLocal = -1;
      if (iterIsString) {
        cp = this.emitStringIteratorElement(ctx, arr, idx, varLocal);
      } else if (mode === "keys") {
        ctx.body.push({ kind: "Copy", dst: varLocal, src: idx });
      } else {
        if (mode === "entries") {
          keyLocal = this.newLocal(ctx, "primitive", "entryKey");
          ctx.body.push({ kind: "Copy", dst: keyLocal, src: idx });
        }
        ctx.body.push({ kind: "LoadIndex", dst: varLocal, arr, index: idx });
      }
      // Iterator.next() advances before binding or running user code. In
      // particular, continue must not skip the index/code-point advance.
      if (iterIsString) this.emitStringIteratorAdvance(ctx, idx, cp);
      else this.emitIndexStep(ctx, idx, 1);
      for (const c of captureCells) {
        ctx.body.push({ kind: "AllocObject", dst: c.cell, typeId: 0, site: c.perSite, classId: this.cellClassId });
      }
      const pat = decl ? decl.name : undefined;
      const twoNames = mode === "entries" && pat !== undefined && ts.isArrayBindingPattern(pat) && pat.elements.length === 2 &&
        pat.elements.every((el) => ts.isBindingElement(el) && !el.dotDotDotToken && !el.initializer);
      if (twoNames && pat && ts.isArrayBindingPattern(pat)) {
        // `[i, v]`: the index and the element, no pair array
        this.lowerBindingPattern(ctx, (pat.elements[0] as ts.BindingElement).name, keyLocal);
        this.lowerBindingPattern(ctx, (pat.elements[1] as ts.BindingElement).name, varLocal);
      } else {
        let bound = varLocal;
        if (mode === "entries") {
          // any other pattern or target destructures a fresh [index, element]
          const site = this.site++;
          this.recordSite(site, "array", "many", false, statement);
          bound = this.newLocal(ctx, "reference", "entryPair");
          ctx.body.push({ kind: "AllocArray", dst: bound, elemType: 0, site });
          ctx.body.push({ kind: "ArrayPush", arr: bound, src: keyLocal });
          ctx.body.push({ kind: "ArrayPush", arr: bound, src: varLocal });
        }
        if (decl) this.lowerBindingPattern(ctx, decl.name, bound);
        else this.lowerAssignTarget(ctx, init as ts.Expression, bound);
      }
      this.emitPerIterationBodyCells(ctx, statement);
      this.lowerStmt(ctx, statement);
    });
    for (const c of captureCells) {
      if (c.saved !== undefined) ctx.cellAccess.set(c.sym, c.saved);
      else ctx.cellAccess.delete(c.sym);
    }
    ctx.body.push({ kind: "Loop", cond: condLocal, condBody, body: bodyB });
  }

  /** `yield* <built-in array/string>`: an index loop that yields each element.
   *  Mirrors lowerArrayIndexForOf's index machinery, but the body yields the element
   *  (suspending the generator) instead of binding a loop var and running a body.
   *  Map/Set are materialized to an array by the caller and passed with isString=false.
   *  Sent values are discarded (built-in iterators ignore them). */
  private emitIndexYieldLoop(ctx: FnCtx, arr: number, isString: boolean): void {
    const idx = this.newLocal(ctx, "primitive");
    const zero = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst: zero, value: { kind: "Num", value: 0 } });
    ctx.body.push({ kind: "Copy", dst: idx, src: zero });
    let condLocal = -1;
    const condBody = this.captureBody(ctx, () => {
      const len = this.newLocal(ctx, "primitive");
      if (isString) ctx.body.push({ kind: "StringLen", dst: len, src: arr });
      else ctx.body.push({ kind: "ArrayLen", dst: len, arr });
      condLocal = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "BinOp", dst: condLocal, op: "<", lhs: idx, rhs: len });
    });
    const bodyB = this.captureLoopBody(ctx, "while", () => {
      const el = this.newLocal(ctx, "reference");
      let cp = -1;
      if (isString) cp = this.emitStringIteratorElement(ctx, arr, idx, el);
      else ctx.body.push({ kind: "LoadIndex", dst: el, arr, index: idx });
      const sent = this.newLocal(ctx, "reference");
      this.emitYieldInst(ctx, sent, el);
      if (isString) this.emitStringIteratorAdvance(ctx, idx, cp);
      else this.emitIndexStep(ctx, idx, 1);
    });
    ctx.body.push({ kind: "Loop", cond: condLocal, condBody, body: bodyB });
  }

  /** AsyncGeneratorYield awaits its operand before exposing the iterator result.
   *  Model that explicitly in IR so the ordinary Await state-machine path handles
   *  thenables, rejection, and scheduler ordering before the Yield suspension. */
  private emitYieldInst(ctx: FnCtx, dst: number, operand: number): void {
    let value = operand;
    if (ctx.isAsync && ctx.isGenerator) {
      value = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Await", dst: value, operand });
    }
    ctx.body.push({ kind: "Yield", dst, operand: value });
  }

  /** Lower `for [await] (decl of <iter>) BODY` driven by a resolved iterator.
   *  Shared by for-of and for-await. Uses fresh loop-var/result locals (nested-
   *  safe) and the "forof_gen" loop kind (continue advances in the cond). */
  /** `TSAOT_FOROF_CURSOR=0`: `for..of` over a Map/Set keeps the iterator protocol. */
  forOfCursorEnabled = process.env.TSAOT_FOROF_CURSOR !== "0" && process.env.TSAOT_UNTYPED !== "1";
  /** The collection a `for..of` can walk with a cursor: a Map (entries), a Set
   *  (values), or `keys()` / `values()` / `entries()` called on one with no
   *  arguments (docs/map_cursor_forof_design.md). */
  forOfCursorTarget(expr: ts.Expression): { coll: ts.Expression; mode: "keys" | "values" | "entries" } | undefined {
    if (!this.forOfCursorEnabled) return undefined;
    let e: ts.Expression = expr;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    const rk = this.builtinReceiverKind(e) ?? this.derivedCollectionKind(e);
    if (rk === "map") return { coll: e, mode: "entries" };
    if (rk === "set") return { coll: e, mode: "values" };
    if (ts.isCallExpression(e) && e.arguments.length === 0 && ts.isPropertyAccessExpression(e.expression)) {
      const m = e.expression.name.text;
      if (m !== "keys" && m !== "values" && m !== "entries") return undefined;
      const rrk = this.builtinReceiverKind(e.expression.expression) ?? this.derivedCollectionKind(e.expression.expression);
      if (rrk === "map") return { coll: e.expression.expression, mode: m };
      if (rrk === "set") return { coll: e.expression.expression, mode: m === "entries" ? "entries" : "values" };
    }
    return undefined;
  }
  /** `TSAOT_FOROF_DYNAMIC=0`: a `for..of` over a value of no known iterable
   *  type walks it as an array (the old lowering: 0 iterations for a Map, a
   *  Set, a generator, a string or a custom iterable held in an `any`). */
  forOfDynamicEnabled = process.env.TSAOT_FOROF_DYNAMIC !== "0";
  /** `for..of` over a value whose iteration protocol is a run-time question
   *  (docs/array_iterators_design.md): `forof.open` gives an array (walked by
   *  index, no iterator object) or an iterator (GetIterator); `forof.next`
   *  returns the next element or the done marker. The iterator is not closed
   *  on an abrupt exit (KNOWN_GAPS.md): a try/finally per loop entry costs
   *  more than the loops it would serve. */
  private lowerDynamicForOf(ctx: FnCtx, init: ts.ForInitializer, statement: ts.Statement, expr: ts.Expression): void {
    const src = this.lowerExpr(ctx, expr);
    const it = this.newLocal(ctx, "reference", "forofIter");
    ctx.body.push({ kind: "CallBuiltin", dst: it, builtin: "forof.open", recv: src, args: [] });
    const idx = this.newLocal(ctx, "primitive");
    const zero = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst: zero, value: { kind: "Num", value: 0 } });
    ctx.body.push({ kind: "Copy", dst: idx, src: zero });
    const elem = this.newLocal(ctx, "reference", "elem");
    const decl = ts.isVariableDeclarationList(init) ? init.declarations[0] : undefined;
    const captureCells = decl && (init.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
      ? this.setupForOfCaptureCells(ctx, decl.name, decl) : [];
    const nextBuiltin = `forof.next:${this.internName("next")}`;
    let condLocal = -1;
    const condBody = this.captureBody(ctx, () => {
      ctx.body.push({ kind: "CallBuiltin", dst: elem, builtin: nextBuiltin, recv: it, args: [idx] });
      const done = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "CallBuiltin", dst: done, builtin: "forof.isDone", recv: elem, args: [] });
      condLocal = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "UnOp", dst: condLocal, op: "!", operand: done });
    });
    const bodyB = this.captureLoopBody(ctx, "forof", () => {
      // the index advances before user code (continue must not skip it)
      this.emitIndexStep(ctx, idx, 1);
      for (const c of captureCells) {
        ctx.body.push({ kind: "AllocObject", dst: c.cell, typeId: 0, site: c.perSite, classId: this.cellClassId });
      }
      if (decl) this.lowerBindingPattern(ctx, decl.name, elem);
      else this.lowerAssignTarget(ctx, init as ts.Expression, elem);
      this.emitPerIterationBodyCells(ctx, statement);
      this.lowerStmt(ctx, statement);
    });
    for (const c of captureCells) {
      if (c.saved !== undefined) ctx.cellAccess.set(c.sym, c.saved);
      else ctx.cellAccess.delete(c.sym);
    }
    ctx.body.push({ kind: "Loop", cond: condLocal, condBody, body: bodyB });
  }
  /** `TSAOT_ARRAY_ITER_FOROF=0`: `for..of` over `arr.values()` / `keys()` /
   *  `entries()` iterates the builtin's result instead of the array itself. */
  arrayIterForOfEnabled = process.env.TSAOT_ARRAY_ITER_FOROF !== "0" && process.env.TSAOT_UNTYPED !== "1";
  /** The array a `for..of` walks for `values()` / `keys()` / `entries()` called
   *  with no arguments on a built-in array (docs/array_iterators_design.md). */
  arrayIteratorForOfTarget(expr: ts.Expression): { arr: ts.Expression; mode: "keys" | "values" | "entries" } | undefined {
    if (!this.arrayIterForOfEnabled) return undefined;
    let e: ts.Expression = expr;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e) || e.arguments.length !== 0 || e.questionDotToken) return undefined;
    const callee = e.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return undefined;
    const m = callee.name.text;
    if (m !== "keys" && m !== "values" && m !== "entries") return undefined;
    if (this.builtinReceiverKind(callee.expression) !== "array") return undefined;
    return { arr: callee.expression, mode: m };
  }
  /** `for..of` over a Map/Set driven by a cursor: the runtime's insertion-order
   *  ids give the protocol's view of mutation during the loop (entries added
   *  are visited, deleted ones skipped), without an iterator object, result
   *  objects or, for a `[k, v]` pattern, the pair arrays. Mirrors
   *  lowerDrivenForLoop's per-iteration capture cells. */
  /** The array a typed `for..of` walks (`forof.arraySource`): the value when it is an array, otherwise
   *  the elements its iteration protocol yields (a Proxy around an array takes the loop through its
   *  [Symbol.iterator] trap: vue's reactive arrays), so the index loop keeps its shape. */
  private forOfArraySource(ctx: FnCtx, arr: number): number {
    const dst = this.newLocal(ctx, "reference", "forofArr");
    ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "forof.arraySource", args: [arr] });
    return dst;
  }
  private lowerCursorForLoop(ctx: FnCtx, init: ts.ForInitializer, body: ts.Statement, target: { coll: ts.Expression; mode: "keys" | "values" | "entries" }): void {
    // the Map or Set itself, or one built from a foreign receiver's protocol (a Proxy around one)
    const collKind = this.builtinReceiverKind(target.coll) ?? this.derivedCollectionKind(target.coll);
    const coll0 = this.lowerExpr(ctx, target.coll);
    const coll = this.newLocal(ctx, "reference", "cursorColl");
    ctx.body.push({ kind: "CallBuiltinStatic", dst: coll, builtin: `map.cursorSource:${collKind === "set" ? "set" : "map"}`, args: [coll0] });
    const decl0 = ts.isVariableDeclarationList(init) ? init.declarations[0] : undefined;
    const captureCells = decl0 && (init.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
      ? this.setupForOfCaptureCells(ctx, decl0.name, decl0) : [];
    const restoreCell = () => {
      for (const c of captureCells) {
        if (c.saved !== undefined) ctx.cellAccess.set(c.sym, c.saved);
        else ctx.cellAccess.delete(c.sym);
      }
    };
    const last = this.newLocal(ctx, "primitive", "cursorLast");
    ctx.body.push({ kind: "Const", dst: last, value: { kind: "Num", value: -1 } });
    const idx = this.newLocal(ctx, "primitive", "cursorIdx");
    ctx.body.push({ kind: "Const", dst: idx, value: { kind: "Num", value: -1 } });
    let cond = -1;
    const condBody = this.captureBody(ctx, () => {
      // the previous index is a hint: the next entry usually follows it
      ctx.body.push({ kind: "CallBuiltinStatic", dst: idx, builtin: "map.cursorNext", args: [coll, last, idx] });
      const zero = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst: zero, value: { kind: "Num", value: 0 } });
      cond = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "BinOp", dst: cond, op: ">=", lhs: idx, rhs: zero });
    });
    const loopBody = this.captureLoopBody(ctx, "forof_cursor", () => {
      ctx.body.push({ kind: "CallBuiltinStatic", dst: last, builtin: "map.cursorOrder", args: [coll, idx] });
      for (const c of captureCells) {
        ctx.body.push({ kind: "AllocObject", dst: c.cell, typeId: 0, site: c.perSite, classId: this.cellClassId });
      }
      const pat = decl0 ? decl0.name : undefined;
      const twoNames = target.mode === "entries" && pat !== undefined && ts.isArrayBindingPattern(pat) && pat.elements.length === 2 &&
        pat.elements.every((el) => ts.isBindingElement(el) && !el.dotDotDotToken && !el.initializer);
      if (twoNames && pat && ts.isArrayBindingPattern(pat)) {
        const k = this.newLocal(ctx, "reference", "cursorKey");
        ctx.body.push({ kind: "CallBuiltinStatic", dst: k, builtin: "map.cursorKey", args: [coll, idx] });
        const v = this.newLocal(ctx, "reference", "cursorVal");
        ctx.body.push({ kind: "CallBuiltinStatic", dst: v, builtin: "map.cursorVal", args: [coll, idx] });
        this.lowerBindingPattern(ctx, (pat.elements[0] as ts.BindingElement).name, k);
        this.lowerBindingPattern(ctx, (pat.elements[1] as ts.BindingElement).name, v);
      } else {
        const value = this.newLocal(ctx, "reference", "elem");
        const builtin = target.mode === "keys" ? "map.cursorKey" : target.mode === "values" ? "map.cursorVal" : "map.cursorPair";
        ctx.body.push({ kind: "CallBuiltinStatic", dst: value, builtin, args: [coll, idx] });
        if (decl0) this.lowerBindingPattern(ctx, decl0.name, value);
        else this.lowerAssignTarget(ctx, init as ts.Expression, value);
      }
      this.emitPerIterationBodyCells(ctx, body);
      this.lowerStmt(ctx, body);
    });
    ctx.body.push({ kind: "Loop", cond, condBody, body: loopBody });
    restoreCell();
  }
  private lowerDrivenForLoop(
    ctx: FnCtx, init: ts.ForInitializer, body: ts.Statement,
    drv: { step: (sent: number) => number; returnCall?: () => void }
  ): void {
    const loopVar = this.newLocal(ctx, "reference", "elem");
    const decl0 = ts.isVariableDeclarationList(init) ? init.declarations[0] : undefined;
    const captureCells = decl0 && (init.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
      ? this.setupForOfCaptureCells(ctx, decl0.name, decl0) : [];
    const restoreCell = () => {
      for (const c of captureCells) {
        if (c.saved !== undefined) ctx.cellAccess.set(c.sym, c.saved);
        else ctx.cellAccess.delete(c.sym);
      }
    };
    const res = this.newLocal(ctx, "reference");
    const valueField = this.internField("value");
    const doneField = this.internField("done");
    const undef0 = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: undef0, value: { kind: "Undef" } });

    // emit the driving while-loop into the current ctx.body.
    const emitLoop = () => {
      let cond = -1;
      const condBody = this.captureBody(ctx, () => {
        const r = drv.step(undef0);
        ctx.body.push({ kind: "Copy", dst: res, src: r });
        const doneVal = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadField", dst: doneVal, obj: res, field: doneField });
        cond = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "UnOp", dst: cond, op: "!", operand: doneVal });
      });
      const loopBody = this.captureLoopBody(ctx, "forof_gen", () => {
        ctx.body.push({ kind: "LoadField", dst: loopVar, obj: res, field: valueField });
        for (const c of captureCells) {
          ctx.body.push({ kind: "AllocObject", dst: c.cell, typeId: 0, site: c.perSite, classId: this.cellClassId });
        }
        if (decl0) this.lowerBindingPattern(ctx, decl0.name, loopVar);
        else this.lowerAssignTarget(ctx, init as ts.Expression, loopVar);
        this.emitPerIterationBodyCells(ctx, body);
        this.lowerStmt(ctx, body);
      });
      ctx.body.push({ kind: "Loop", cond, condBody, body: loopBody });
    };

    if (!drv.returnCall) {
      // no iterator-close to do: plain driving loop.
      emitLoop();
      restoreCell();
      return;
    }

    // The iterator exposes .return(): close it on ABNORMAL loop exit (break /
    // return / throw escaping the loop), but NOT on natural exhaustion. We use a
    // `normalDone` flag set only after the loop completes normally, wrapped in a
    // try/finally so any abrupt exit still runs the close. This reuses the tested
    // finally-through-unwind machinery rather than intercepting break directly.
    const normalDone = this.newLocal(ctx, "primitive");
    const falseC = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst: falseC, value: { kind: "Bool", value: false } });
    ctx.body.push({ kind: "Copy", dst: normalDone, src: falseC });
    const tryBody = this.captureBody(ctx, () => {
      emitLoop();
      // The loop exits either by natural exhaustion (res.done === true) or by an
      // abrupt break/return/throw. Only natural exhaustion is a "normal" completion
      // that must NOT close the iterator; break falls through here with res.done
      // still false, while return/throw skip this entirely (handled by finally).
      const d = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadField", dst: d, obj: res, field: doneField });
      ctx.body.push({ kind: "Copy", dst: normalDone, src: d });
    });
    const finallyBody = this.captureBody(ctx, () => {
      // if (!normalDone) it.return();
      const notDone = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "UnOp", dst: notDone, op: "!", operand: normalDone });
      const thenBody = this.captureBody(ctx, () => { drv.returnCall!(); });
      ctx.body.push({ kind: "If", cond: notDone, thenBody, elseBody: [] });
    });
    ctx.body.push({ kind: "TryCatch", tryBody, catchVar: null, catchBody: [], finallyBody });
    restoreCell();
  }

  /** Detect yields NOT in a supported top-level position (mirrors
   *  hasNestedAwait): `yield e;`, `const x = yield e;`, `x = yield e;`. */
  hasNestedYield(body: ts.Node): boolean {
    let nested = false;
    const isYield = (n: ts.Node | undefined): n is ts.YieldExpression =>
      !!n && ts.isYieldExpression(n);
    const stmts = ts.isBlock(body) ? body.statements : [];
    const scanStray = (n: ts.Node) => {
      const v = (x: ts.Node) => {
        if (nested) return;
        if (ts.isYieldExpression(x)) { nested = true; return; }
        if (ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || ts.isArrowFunction(x)) return;
        ts.forEachChild(x, v);
      };
      v(n);
    };
    for (const st of stmts) {
      if (ts.isExpressionStatement(st)) {
        const e = st.expression;
        if (isYield(e)) { if (e.expression) scanStray(e.expression); continue; }
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && isYield(e.right)) {
          scanStray(e.left); if (e.right.expression) scanStray(e.right.expression); continue;
        }
        scanStray(e);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (d.initializer && isYield(d.initializer)) { if (d.initializer.expression) scanStray(d.initializer.expression); }
          else if (d.initializer) scanStray(d.initializer);
        }
      } else if (ts.isReturnStatement(st)) {
        if (st.expression) scanStray(st.expression);
      } else {
        scanStray(st);
      }
      if (nested) break;
    }
    return nested;
  }

  hasYieldStar(body: ts.Node): boolean {
    let found = false;
    const v = (x: ts.Node) => {
      if (found) return;
      if (ts.isYieldExpression(x) && x.asteriskToken) { found = true; return; }
      if (ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || ts.isArrowFunction(x)) return;
      ts.forEachChild(x, v);
    };
    v(body);
    return found;
  }

  /** Classify `obj[idx]`: "string" if the index is a string-typed key (object
   *  property access), "number" otherwise (array/tuple index). */
  /** Is this element-access key a well-known Symbol expression (Symbol.iterator,
   *  Symbol.asyncIterator, ...)? Such `obj[Symbol.X]` access/assignment outside a
   *  class member declaration is not modeled (the key would be coerced to the
   *  string "Symbol(Symbol.iterator)" via ts_to_string_v and silently mis-stored),
   *  so callers reject it loudly (C0). Class methods `[Symbol.iterator]()` are
   *  handled separately by wellKnownMethodName and are unaffected. */
  isSymbolKeyExpr(arg: ts.Expression): boolean {
    let e: ts.Expression = arg;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && this.isBuiltinNamespaceRef(e.expression, "Symbol")) return true;
    // a value of type `symbol`/`unique symbol` used as a computed key
    try {
      const t = this.checker.getTypeAtLocation(e);
      if (t.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return true;
    } catch { /* ignore */ }
    return false;
  }
  /** If `arg` is a well-known symbol reference (`Symbol.iterator` etc.), return
   *  its TS_WKSYM_* id; otherwise undefined (it's a user symbol value). */
  wellKnownSymbolId(arg: ts.Expression): number | undefined {
    let e: ts.Expression = arg;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && this.isBuiltinNamespaceRef(e.expression, "Symbol")) {
      switch (e.name.text) {
        case "iterator": return 0;
        case "asyncIterator": return 1;
        case "toPrimitive": return 2;
        case "hasInstance": return 3;
        case "toStringTag": return 4;
        default: return undefined;
      }
    }
    return undefined;
  }

  indexAccessKind(node: ts.ElementAccessExpression): "string" | "number" {
    // A string-literal index is always a property key.
    if (ts.isStringLiteral(node.argumentExpression)) return "string";
    // The "number" path lowers to LoadIndex/StoreIndex (the array element fast
    // path, ts_array_get/set with a uint32 index). That is ONLY correct when the
    // base is provably an array. On a plain object a numeric key is just a string
    // property after ToString (`a[1.5]` -> key "1.5", `a[0]` -> key "0", and
    // `a[0]` === `a["0"]`), which the "string" path handles via ts_get/set_dyn's
    // ToString normalization. So route to "number" only for arrays; otherwise the
    // (possibly numeric) key is a property access — this keeps a[0]/a["0"] unified
    // and a[1.5] correct, matching JS semantics (property keys are strings).
    // A typed array's index is an element read through the runtime's element
    // path; any other key is a property key (docs/typed_arrays_design.md).
    if (this.isTypedArrayReceiver(node.expression))
      return this.isNumberTypedKey(node.argumentExpression) ? "number" : "string";
    const bk = this.builtinReceiverKind(node.expression);
    // The index path reads its key as a raw number (`(uint32_t)ts_to_num(k)`
    // in the emitted element access), so only a number-typed key may take it.
    // A string key (`for (const k in arr) arr[k]`, an index held in a string)
    // or an `any`, union or type-parameter key is a property key after
    // ToPropertyKey: the dynamic path maps a canonical index string to the
    // element. (Every such key used to read and write element 0.)
    if (bk === "array" || bk === "string")   // str[i] char access also uses the index path
      return this.isNumberTypedKey(node.argumentExpression) ? "number" : "string";
    try {
      const t = this.checker.getTypeAtLocation(node.argumentExpression);
      const F = ts.TypeFlags;
      // Non-array base: a numeric OR string key is a property access (string path).
      if (t.flags & (F.NumberLike | F.Number | F.NumberLiteral)) return "string";
      if (t.flags & (F.StringLike | F.String | F.StringLiteral)) return "string";
      return "string";
    } catch { return "string"; }
  }

  /** The element type (TS_TA_*) of a receiver whose static type is a view of
   *  one element type (a union of such views, with null / undefined, too);
   *  undefined otherwise. */
  viewElemOf(e: ts.Expression): number | undefined {
    try {
      const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
      const elemOf = (m: ts.Type): number | undefined => {
        const sym = m.getSymbol();
        return sym && this.isAmbientGlobalSymbol(sym) ? TYPED_ARRAY_ELEMS.get(sym.name) : undefined;
      };
      if (!t.isUnion()) return elemOf(t);
      const elems = t.types.map(elemOf);
      return elems.every((x) => x !== undefined && x === elems[0]) ? elems[0] : undefined;
    } catch { return undefined; }
  }
  /** Mark an element access or a `length` read whose receiver is statically a
   *  view (docs/typed_arrays_design.md, TA2): the emitter reads and writes its
   *  elements in line. */
  /** The receiver class hint of a field access (`cls`: class id + 1, 0
   *  none): under the strict type profile, a receiver whose static type at the
   *  access (narrowed, without null and undefined; a type parameter by its
   *  constraint) is one stable, non-generic class. The structural flow pass
   *  (`class_extract.ts`) makes a class unstable when a value that is not one
   *  of its instances can be typed as it; a cast receiver takes the cast's
   *  class. The emitter reads
   *  the field at the class's struct offset; a receiver that is not an object
   *  takes the generic access (docs/receiver_class_hints_design.md). */
  private receiverClassHint(e: ts.Expression): number {
    if (process.env.TSAOT_CLASS_HINTS === "0" || !this.strictTypeOptimizationProfile().enabled) return 0;
    let r = e;
    while (ts.isParenthesizedExpression(r)) r = r.expression;
    // A cast receiver (`(x as C).f`) is read as the cast's class: a wrong
    // downcast is caught by the emitted guard (a leaf's field tests the
    // prototype), and a reinterpretation across hierarchies (through `unknown`,
    // from an interface or an unrelated class) left the class unstable.
    if ((ts.isAsExpression(r) || ts.isTypeAssertionExpression(r)) && process.env.TSAOT_CAST_HINTS === "0") return 0;
    try {
      let t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(r));
      if (t.flags & ts.TypeFlags.TypeParameter) {
        const c = this.checker.getBaseConstraintOfType(t);
        if (!c) return 0;
        t = this.checker.getNonNullableType(c);
      }
      if (t.getConstructSignatures().length > 0) return 0;
      const sym = t.getSymbol();
      const cid = sym ? this.classSymToId.get(sym) : undefined;
      if (cid === undefined) return 0;
      // An unstable class whose instances are still sized structs with the declared layout (its
      // instability is a value of another kind typed as it, a dynamic member, a replaced method:
      // not a foreign base or a reassigned prototype) takes the hint too; the emitter guards such
      // an access by the class interval, so a non-instance reads generically
      // (docs/hidden_class_design.md S0). TSAOT_UNSTABLE_HINTS=0 keeps the sized cache there.
      if (!this.classInfos[cid]?.stable && !this.classLayoutPreserved(cid)) return 0;
      // A generic class takes the hint too: its layout is one per class, not per instantiation (a field
      // typed by a type parameter is a boxed slot), and the hint names the class, not the arguments.
      if (!this.classNodeOfId.has(cid)) return 0;
      return cid + 1;
    } catch {
      return 0;
    }
  }
  private withClassHint<T extends { kind: string }>(inst: T, receiver: ts.Expression): T {
    const cls = this.receiverClassHint(receiver);
    if (cls !== 0) {
      (inst as unknown as { cls?: number }).cls = cls;
      // an unstable class's hint the emitter may decline (no interval): the sized probe then
      if (!this.classInfos[cls - 1]?.stable) (inst as unknown as { sized?: boolean }).sized = true;
    } else if (this.receiverAdmitsClassInstance(receiver)) (inst as unknown as { sized?: boolean }).sized = true;
    return inst;
  }
  /** An unstable class whose instances keep the declared struct layout and prototype chain (the
   *  emitter's chain-preserving rule for class intervals): every reason is a static one. */
  private classLayoutPreserved(cid: number): boolean {
    if (process.env.TSAOT_UNSTABLE_HINTS === "0") return false;
    const info = this.classInfos[cid];
    if (!info || !this.classNodeOfId.has(cid)) return false;
    return info.reasons.every((r) => r !== "prototype-assign" && !r.startsWith("extends-") && !r.startsWith("cyclic-extends"));
  }
  /** Whether a value of the receiver's static type can be a class instance without the type naming
   *  one stable class (docs/pic_sized_inline_design.md, "The interface-typed site"): an interface,
   *  type literal or union some program class is assignable to (vue's `Subscriber`, implemented by
   *  ReactiveEffect and ComputedRefImpl), or a class without a hint (unstable, or a union of classes).
   *  Such a site's inline cache probes the sized-receiver entries after the plain-object one; a site
   *  whose type admits no instance (`any`, an object literal's own interface, an array) keeps the
   *  plain-object probe alone, which the typed compiler's sites need (the sized try on every inline
   *  miss cost it 1.3% of its instructions). `TSAOT_SIZED_SITES=0` marks no site. */
  private receiverAdmitsClassInstance(e: ts.Expression): boolean {
    if (process.env.TSAOT_SIZED_SITES === "0" || !this.strictTypeOptimizationProfile().enabled) return false;
    let r = e;
    while (ts.isParenthesizedExpression(r)) r = r.expression;
    let t: ts.Type;
    try { t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(r)); } catch { return false; }
    return this.typeAdmitsClassInstance(t, 0);
  }
  private admitsClassCache = new Map<ts.Type, boolean>();
  private typeAdmitsClassInstance(t: ts.Type, depth: number): boolean {
    if (depth > 2) return false;
    if (t.flags & ts.TypeFlags.TypeParameter) {
      let c: ts.Type | undefined;
      try { c = this.checker.getBaseConstraintOfType(t); } catch { return false; }
      return c ? this.typeAdmitsClassInstance(this.checker.getNonNullableType(c), depth + 1) : false;
    }
    if (t.isUnionOrIntersection()) return t.types.some((m) => this.typeAdmitsClassInstance(m, depth + 1));
    if (!(t.flags & ts.TypeFlags.Object)) return false;
    const hit = this.admitsClassCache.get(t);
    if (hit !== undefined) return hit;
    let res = false;
    try {
      const sym = t.getSymbol();
      const own = sym ? this.classSymToId.get(sym) : undefined;
      if (own !== undefined) res = t.getConstructSignatures().length === 0;   // an instance type (not `typeof C`)
      else if (t.getCallSignatures().length === 0 && t.getConstructSignatures().length === 0) {
        for (const [csym, cid] of this.classSymToId) {
          if (!this.classNodeOfId.has(cid)) continue;
          const inst = this.checker.getDeclaredTypeOfSymbol(csym);
          if (this.checker.isTypeAssignableTo(inst, t)) { res = true; break; }
        }
      }
    } catch { res = false; }
    this.admitsClassCache.set(t, res);
    return res;
  }
  private withViewElem<T extends { kind: string }>(inst: T, receiver: ts.Expression): T {
    const elem = this.viewElemOf(receiver);
    if (elem !== undefined) (inst as unknown as { elem?: number }).elem = elem + 1;
    return inst;
  }
  /** A receiver whose static type is an ambient typed array (or a union of
   *  them, with null / undefined). */
  isTypedArrayReceiver(e: ts.Expression): boolean {
    try {
      const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
      const isTa = (m: ts.Type): boolean => {
        const sym = m.getSymbol();
        return !!sym && TYPED_ARRAY_ELEMS.has(sym.name) && this.isAmbientGlobalSymbol(sym);
      };
      return t.isUnion() ? t.types.every(isTa) : isTa(t);
    } catch { return false; }
  }

  /** A key whose static type is a number (number, a number literal, a
   *  numeric enum, or a union of those). */
  isNumberTypedKey(e: ts.Expression): boolean {
    try {
      const t = this.checker.getTypeAtLocation(e);
      const F = ts.TypeFlags;
      if (t.flags & F.NumberLike) return true;
      if (t.isUnion()) return t.types.every((m) => (m.flags & F.NumberLike) !== 0);
      return false;
    } catch { return false; }
  }

  lowerProtoArg(ctx: FnCtx, arg: ts.Expression): number {
    let e: ts.Expression = arg;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isPropertyAccessExpression(e) && e.name.text === "prototype") {
      const classId = this.classIdOfIdentifier(e.expression);
      if (classId !== undefined) {
        const klass = this.lowerExpr(ctx, e.expression);
        return this.loadClassValuePrototype(ctx, klass);
      }
    }
    return this.lowerExpr(ctx, arg);
  }

  classIdOfIdentifier(e: ts.Expression): number | undefined {
    let u: ts.Node = e;
    while (ts.isParenthesizedExpression(u) || ts.isAsExpression(u) || ts.isNonNullExpression(u)) u = u.expression;
    if (!ts.isIdentifier(u)) return undefined;
    const sym = this.symbolOf(u);
    return sym ? this.classSymToId.get(sym) : undefined;
  }

  /** Is `lhs` a plain runtime field store (NOT a static-class field, NOT
   *  `C.prototype.m`, NOT an accessor setter)? Only these (and element access)
   *  have their object/key evaluated as runtime values, so only these are subject
   *  to JS target-before-RHS evaluation order. */
  isPlainFieldStoreTarget(lhs: ts.PropertyAccessExpression): boolean {
    // `super.x` has no runtime base value to pre-evaluate; route it to the simple
    // assignment path (lowerAssignTarget handles super), not the obj/key pre-eval one.
    if (lhs.expression.kind === ts.SyntaxKind.SuperKeyword) return false;
    if (ts.isIdentifier(lhs.expression)) {
      const csym = this.symbolOf(lhs.expression);
      const cid = csym ? this.classSymToId.get(csym) : undefined;
      if (cid !== undefined && this.classStaticGlobal.has(cid)) return false;
    }
    let inner: ts.Expression = lhs.expression;
    while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
    if (ts.isPropertyAccessExpression(inner) && inner.name.text === "prototype" && this.classIdOfIdentifier(inner.expression) !== undefined) return false;
    const sClass = this.classOfExpr(lhs.expression);
    if (sClass !== undefined && this.hasSetter(sClass, lhs.name.text)) return false;
    return true;
  }

  /** Evaluate an assignment TARGET's object/key BEFORE the RHS (JS order), with a
   *  snapshot of bare-variable object/key when the RHS may mutate them. Returns
   *  pre-lowered locals to hand to lowerAssignTarget. Only for element access and
   *  plain-field property access (the eval-order-sensitive targets). */
  lowerAssignRefPre(ctx: FnCtx, lhs: ts.Expression, rhsMayMutate: boolean): { obj?: number; key?: number } {
    const snap = (loc: number, e: ts.Expression): number => {
      if (rhsMayMutate && this.isMutableStorageLocal(ctx, loc)) {
        const s = this.newLocal(ctx, this.refKindOf(e));
        ctx.body.push({ kind: "Copy", dst: s, src: loc });
        return s;
      }
      return loc;
    };
    if (ts.isPropertyAccessExpression(lhs)) {
      return { obj: snap(this.lowerExpr(ctx, lhs.expression), lhs.expression) };
    }
    // element access: object then key (JS order), each snapshotted if needed
    const ea = lhs as ts.ElementAccessExpression;
    const obj = snap(this.lowerExpr(ctx, ea.expression), ea.expression);
    const key = snap(this.lowerExpr(ctx, ea.argumentExpression), ea.argumentExpression);
    return { obj, key };
  }

  /** Read the CURRENT value of an assignment target through a pre-evaluated
   *  object/key (from lowerAssignRefPre), so a compound assignment such as
   *  `a[i++] += v` evaluates its target reference EXACTLY ONCE — shared by the
   *  read and the write. Mirrors the member-read lowering of lowerExpr but reads
   *  via the snapshotted reference. Only for element access and plain-field
   *  property access (the same targets lowerAssignTarget's `pre` path handles). */
  lowerReadFromRef(ctx: FnCtx, lhs: ts.Expression, pre: { obj?: number; key?: number }): number {
    const dst = this.newLocal(ctx, this.refKindOf(lhs));
    if (ts.isPropertyAccessExpression(lhs)) {
      ctx.body.push(this.withClassHint(this.withSlots({ kind: "LoadField", dst, obj: pre.obj!, field: this.internField(lhs.name.text) }, this.staticSlotHint(lhs.expression, lhs.name.text)), lhs.expression));
      return dst;
    }
    const lea = lhs as ts.ElementAccessExpression;
    if (this.isSymbolKeyExpr(lea.argumentExpression)) {
      ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "symbol.get", args: [pre.obj!, pre.key!] });
      return dst;
    }
    if (this.indexAccessKind(lea) === "string") {
      ctx.body.push({ kind: "LoadFieldDynamic", dst, obj: pre.obj!, key: pre.key! });
      return dst;
    }
    ctx.body.push(this.withViewElem({ kind: "LoadIndex", dst, arr: pre.obj!, index: pre.key! }, lea.expression));
    return dst;
  }

  lowerAssignTarget(ctx: FnCtx, lhs: ts.Expression, rhs: number, pre?: { obj?: number; key?: number }) {
    // `(o.f) = v`, `o.f! = v`, `(o as T).f = v`: the wrappers do not change the
    // reference. (A wrapped target used to fall through every branch below and
    // drop the store silently; the final branch now rejects loudly.)
    lhs = this.unwrapAssignTarget(lhs);
    if (ts.isIdentifier(lhs)) {
      const sym = this.symbolOf(lhs);
      const namespace = sym && this.namespaceBindings.get(sym);
      if (namespace) {
        const obj = this.namespaceObject(ctx, namespace.namespace);
        ctx.body.push({ kind: "StoreField", obj, field: this.internField(namespace.name), src: rhs });
        return;
      }
      const declaration = sym?.valueDeclaration;
      if (declaration && ts.isFunctionExpression(declaration) && declaration.name &&
          this.symbolOf(declaration.name) === sym) {
        this.emitThrowTypeError(ctx, lhs, "Assignment to constant variable.");
        return;
      }
      if (sym && this.funcSymbols.has(sym) && !this.isScriptGlobalVarSymbol(sym, lhs.text)) {
        // Direct calls bind to the declaration; a rebinding would silently be
        // bypassed by them.
        if (process.env.TSAOT_DEBUG_FNVALUE) {
          console.error(`[fnvalue] assignment target '${lhs.text}' decls: ${(sym.declarations ?? []).map((d) => `${ts.SyntaxKind[d.kind]}@${d.getSourceFile().fileName}:${d.getSourceFile().getLineAndCharacterOfPosition(d.pos).line + 1}`).join(", ")}`);
        }
        this.unsupported(lhs, `assignment to the function declaration binding '${lhs.text}'`);
      }
      if (this.isScriptGlobalVarSymbol(sym, lhs.text)) {
        this.storeGlobalObjectProperty(ctx, lhs.text, rhs);
      } else if (this.globalObjectValueName(lhs.text) !== undefined && this.isAmbientGlobalSymbol(sym)) {
        this.storeGlobalObjectProperty(ctx, lhs.text, rhs);
      } else if (this.isAmbientValueSymbol(sym)) {
        // a value the environment provides lives on the global object (strict:
        // assigning one that is not there is a ReferenceError)
        ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
          builtin: `global.assignRef:${lhs.text}`, args: [rhs] });
      } else if (this.isLexicalTdzUse(lhs, sym)) {
        this.unsupported(lhs, `TDZ write of '${lhs.text}' before initialization`);
      } else if (sym && this.hasCaptured(ctx, sym)) {
        this.storeCaptured(ctx, sym, rhs);
      } else if (sym && this.moduleCellGlobal.has(sym)) {
        // Step E: write to a module binding from a method — its record field,
        // or the cell loaded from its GLOBALS[] slot.
        const ref = this.moduleCapturedRef(ctx, sym)!;
        ctx.body.push({ kind: "StoreField", obj: ref.obj, field: ref.field, src: rhs, ...(ref.cls ? { cls: ref.cls } : {}) });
      } else if (sym) {
        // Step B: module bindings no longer use StoreGlobal; fall through to a
        // function-local store (cells come in Step C). See lowerIdentifier.
        const lid = this.ensureLocal(ctx, sym, this.refKindOf(lhs), lhs.text);
        ctx.body.push({ kind: "Copy", dst: lid, src: rhs });
      }
    } else if (ts.isPropertyAccessExpression(lhs)) {
      // `re.lastIndex op= v` and the update forms on a receiver typed RegExp: the slot write
      if (lhs.name.text === "lastIndex" && this.isRegExpExpr(lhs.expression)) {
        const recv = this.lowerExpr(ctx, lhs.expression);
        ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "regexp.setLastIndex", args: [recv, rhs] });
        return;
      }
      // `super.x = v`: resolve a setter from the PARENT (call it with this=receiver),
      // else write an own data property on the receiver — skipping the current class's
      // own setter, per JS super semantics. Mirrors the §72 super READ resolution.
      if (lhs.expression.kind === ts.SyntaxKind.SuperKeyword) {
        const nm = lhs.name.text;
        // A super setter is Direct-called with the receiver in `recv` (NOT args[0]),
        // matching the super-method call shape (exporter.ts:2207): this is what lets
        // SROA's inline_callee fully scalar-replace the setter's `this.field` write on
        // a non-escaping instance (the same recursion that expands super.method()).
        // static method/block body: `this` is the static container.
        if (ctx.staticClass !== undefined && ctx.thisLocal !== undefined) {
          const parent = this.parentIdOf(ctx.staticClass);
          const sfn = parent !== undefined ? this.staticSetterFnOf(parent, nm) : undefined;
          if (sfn !== undefined) {
            ctx.body.push({ kind: "Call", dst: this.newLocal(ctx, "reference"), recv: ctx.thisLocal, callee: { kind: "Direct", func: sfn }, args: [rhs] });
            return;
          }
          if (parent !== undefined && this.staticGetterFnOf(parent, nm) !== undefined) {
            // parent static accessor has a getter but no setter -> JS throws TypeError.
            this.emitThrowTypeError(ctx, lhs, `Cannot set property ${nm} of class which has only a getter`);
            return;
          }
          if (this.staticSetterFunc.has(`${ctx.staticClass}:static:${nm}`)) {
            // receiver (this class) has its OWN static setter the parent lacks: the
            // receiver's own accessor blocks the data write -> JS throws TypeError.
            this.emitThrowTypeError(ctx, lhs, `Cannot set property ${nm} of class which has only a getter`);
            return;
          }
          ctx.body.push({ kind: "StoreField", obj: ctx.thisLocal, field: this.internField(nm), src: rhs });
          return;
        }
        // instance method body: `this` is the instance.
        if (ctx.currentClass !== undefined && ctx.thisLocal !== undefined) {
          const parent = this.parentIdOf(ctx.currentClass);
          const sfn = parent !== undefined ? this.resolveMemberFunc(parent, nm, "setter") : undefined;
          if (sfn !== undefined) {
            // parent's setter accessor: Direct-call with this=receiver (recv). SROA
            // inlines+scalar-replaces it just like super.method().
            ctx.body.push({ kind: "Call", dst: this.newLocal(ctx, "reference"), recv: ctx.thisLocal, callee: { kind: "Direct", func: sfn }, args: [rhs] });
            return;
          }
          if (parent !== undefined && this.hasGetter(parent, nm)) {
            // parent accessor has a getter but no setter -> JS throws TypeError.
            this.emitThrowTypeError(ctx, lhs, `Cannot set property ${nm} which has only a getter`);
            return;
          }
          if (this.classHasField(ctx.currentClass, nm)) {
            // declared data field: write it as an own property on the instance.
            // (StoreField never invokes a setter, so this correctly skips any own
            // setter on the current class — matching super's parent-resolution.)
            ctx.body.push({ kind: "StoreField", obj: ctx.thisLocal, field: this.internField(nm), src: rhs });
            return;
          }
          // undeclared property (or one whose only declaration is a setter on the
          // current class's prototype): JS creates an OWN data property on the
          // receiver instance, skipping any prototype setter. A normal dynamic store
          // routes through ts_set and would invoke the current prototype setter, so
          // define an own enumerable/writable/configurable data property directly.
          const keyL = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Const", dst: keyL, value: { kind: "Str", value: nm } });
          ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
            builtin: "object.defineData:1:1:1", args: [ctx.thisLocal, keyL, rhs] });
          return;
        }
        // super outside a class method body: fall through to the generic reject.
      }
      // Step F: ClassName.staticField = rhs -> store into the class's static
      // container (loaded from its GLOBALS[] slot).
      if (ts.isIdentifier(lhs.expression)) {
        const csym = this.symbolOf(lhs.expression);
        const cid = csym ? this.classSymToId.get(csym) : undefined;
        if (cid !== undefined && this.classStaticGlobal.has(cid)) {
          // `C.x = rhs` (static field) or `C.v = rhs` (static setter): store into the
          // class's static container via ts_set. The container is proto-linked, so
          // ts_set auto-invokes a registered setter found up the chain (with
          // this=container, subclass-aware). A getter-only accessor write is ignored
          // by ts_set (sloppy-mode semantics, matching the eval test oracle).
          // a static setter: a Direct call with the class value as `this`
          const sfn = this.staticAccessorBeforeField(cid, lhs.name.text, "set");
          if (sfn !== undefined) {
            const recv = this.staticReceiver(ctx, lhs.expression, cid, cid);
            ctx.body.push({ kind: "Call", dst: this.newLocal(ctx, "reference"), callee: { kind: "Direct", func: sfn }, args: [recv, rhs] });
            return;
          }
          const gid = this.classStaticGlobal.get(cid)!;
          const cont = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadGlobal", dst: cont, gref: gid });
          ctx.body.push({ kind: "StoreField", obj: cont, field: this.internField(lhs.name.text), src: rhs });
          return;
        }
      }
      // `this.staticField = rhs` / `this.v = rhs` inside a static body is now generic:
      // `this` is the receiver static container (arg0), so the StoreField below lowers
      // to ts_set(this, ...) — which auto-invokes a setter and, for an inherited data
      // field, creates a shadowing own property on the receiver (matching JS).
      // C.prototype.method = fn  -> reassign a method on the class prototype.
      // Strip parens/casts: e.g. (C.prototype as any).m = ...
      let inner: ts.Expression = lhs.expression;
      while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
      if (ts.isPropertyAccessExpression(inner) && inner.name.text === "prototype") {
        const proto = pre?.obj ?? this.lowerExpr(ctx, inner);
        ctx.body.push({ kind: "StoreField", obj: proto, field: this.internField(lhs.name.text), src: rhs });
        if (lhs.name.text !== "constructor") {
          ctx.body.push({ kind: "StoreMethod", obj: proto, method: this.internName(lhs.name.text), src: rhs });
        }
        return;
      }
      // setter: obj.x = v where x is an accessor -> a method call passing v
      const sClass = this.classOfExpr(lhs.expression);
      if (sClass !== undefined && this.hasSetter(sClass, lhs.name.text)) {
        const recv = this.lowerExpr(ctx, lhs.expression);
        ctx.body.push({
          kind: "Call", recv, args: [rhs],
          callee: { kind: "Method", recvClass: sClass, method: this.internName(`set ${lhs.name.text}`),
                    recvStable: this.classExtractor.recvStableAt(lhs.expression) },
        });
        return;
      }
      const base = pre?.obj ?? this.lowerExpr(ctx, lhs.expression);
      ctx.body.push(this.withClassHint(this.withSlots({ kind: "StoreField", obj: base, field: this.internField(lhs.name.text), src: rhs }, this.staticSlotHint(lhs.expression, lhs.name.text)), lhs.expression));
    } else if (ts.isElementAccessExpression(lhs)) {
      // obj[symbolKey] = v — symbol-keyed property write (user OR well-known).
      if (this.isSymbolKeyExpr(lhs.argumentExpression)) {
        const base = pre?.obj ?? this.lowerExpr(ctx, lhs.expression);
        const symLocal = pre?.key ?? this.lowerExpr(ctx, lhs.argumentExpression);
        ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
          builtin: "symbol.set", args: [base, symLocal, rhs] });
        return;
      }
      const base = pre?.obj ?? this.lowerExpr(ctx, lhs.expression);
      if (this.indexAccessKind(lhs) === "string") {
        const key = pre?.key ?? this.lowerExpr(ctx, lhs.argumentExpression);
        ctx.body.push({ kind: "StoreFieldDynamic", obj: base, key, src: rhs });
      } else {
        const idx = pre?.key ?? this.lowerExpr(ctx, lhs.argumentExpression);
        ctx.body.push(this.withViewElem({ kind: "StoreIndex", arr: base, index: idx, src: rhs }, lhs.expression));
      }
    } else if (ts.isArrayLiteralExpression(lhs)) {
      // destructuring ASSIGNMENT target: [a, b, ...rest] = rhsArray. Read each
      // element from rhs by index and assign recursively to each target. (This is
      // assignment to existing lvalues; declaration destructuring uses
      // lowerBindingPattern.) Supports holes (elisions) and a trailing rest.
      const elems = lhs.elements;
      for (let i = 0; i < elems.length; i++) {
        const el = elems[i];
        if (ts.isOmittedExpression(el)) continue; // hole: [, x] = arr
        if (ts.isSpreadElement(el)) {
          // ...rest = rhs.slice(i)
          const startL = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst: startL, value: { kind: "Num", value: i } });
          const restL = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "CallBuiltin", dst: restL, builtin: "array.slice", recv: rhs, args: [startL] });
          this.lowerAssignTarget(ctx, el.expression, restL);
          break;
        }
        // element value: rhs[i]
        const idxL = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst: idxL, value: { kind: "Num", value: i } });
        const elemL = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadIndex", dst: elemL, arr: rhs, index: idxL });
        // a defaulted target `[a = 1] = arr`: use default when element is undefined.
        let target: ts.Expression = el;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const isUndef = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "UnOp", dst: isUndef, op: "isundef", operand: elemL });
          const thenB = this.captureBody(ctx, () => {
            const dv = this.lowerExpr(ctx, el.right);
            ctx.body.push({ kind: "Copy", dst: elemL, src: dv });
          });
          ctx.body.push({ kind: "If", cond: isUndef, thenBody: thenB, elseBody: [] });
          target = el.left;
        }
        this.lowerAssignTarget(ctx, target, elemL);
      }
    } else if (ts.isObjectLiteralExpression(lhs)) {
      // destructuring ASSIGNMENT target: ({a, b: alias} = rhsObj).
      for (const p of lhs.properties) {
        if (ts.isShorthandPropertyAssignment(p)) {
          const valL = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadField", dst: valL, obj: rhs, field: this.internField(p.name.text) });
          // shorthand default: ({a = 1} = obj)
          if (p.objectAssignmentInitializer) {
            const isUndef = this.newLocal(ctx, "primitive");
            ctx.body.push({ kind: "UnOp", dst: isUndef, op: "isundef", operand: valL });
            const thenB = this.captureBody(ctx, () => {
              const dv = this.lowerExpr(ctx, p.objectAssignmentInitializer!);
              ctx.body.push({ kind: "Copy", dst: valL, src: dv });
            });
            ctx.body.push({ kind: "If", cond: isUndef, thenBody: thenB, elseBody: [] });
          }
          // The shorthand target is the VARIABLE, not the property: getSymbolAt-
          // Location(p.name) yields the property symbol, so resolve the value
          // symbol explicitly and store into its existing local.
          const vsym = this.checker.getShorthandAssignmentValueSymbol(p) ?? this.symbolOf(p.name);
          if (vsym && this.hasCaptured(ctx, vsym)) {
            this.storeCaptured(ctx, vsym, valL);
          } else if (vsym && this.moduleCellGlobal.has(vsym)) {
            const ref = this.moduleCapturedRef(ctx, vsym)!;
            ctx.body.push({ kind: "StoreField", obj: ref.obj, field: ref.field, src: valL, ...(ref.cls ? { cls: ref.cls } : {}) });
          } else if (vsym) {
            const lid = this.ensureLocal(ctx, vsym, this.refKindOf(p.name), p.name.text);
            ctx.body.push({ kind: "Copy", dst: lid, src: valL });
          }
        } else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
          const valL = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadField", dst: valL, obj: rhs, field: this.internField(p.name.text) });
          this.lowerAssignTarget(ctx, p.initializer, valL);
        } else {
          this.unsupported(p, "object destructuring assignment property form");
        }
      }
    } else {
      this.unsupported(lhs, `assignment target of kind ${ts.SyntaxKind[lhs.kind]}`);
    }
  }
  /** Strip parentheses and type assertions (`!`, `as`, `<T>`, `satisfies`) from
   *  an assignment target; they do not change the reference being assigned. */
  private unwrapAssignTarget(lhs: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(lhs) || ts.isNonNullExpression(lhs) || ts.isAsExpression(lhs) || ts.isTypeAssertionExpression(lhs) || ts.isSatisfiesExpression(lhs)) lhs = lhs.expression;
    return lhs;
  }

  /** Does this arrow function reference `this` lexically (directly, or inside a
   *  nested arrow, but NOT inside a nested non-arrow function which rebinds this)?
   *  Arrows don't bind their own `this`; it comes from the enclosing scope, so a
   *  `this`-using arrow must capture the enclosing function's `this`. */
  arrowUsesThis(node: ts.ArrowFunction): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (n.kind === ts.SyntaxKind.ThisKeyword) { found = true; return; }
      // a non-arrow function rebinds `this`, so its body's `this` is not ours.
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
          ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
          ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n)) return;
      ts.forEachChild(n, visit);
    };
    if (node.body) visit(node.body);
    return found;
  }

  /** Does this plain function's body reference its OWN `this` (directly, or
   *  through nested arrows, which inherit it)? Nested non-arrow functions rebind
   *  `this`, so their bodies don't count. Such a function is lowered with the
   *  args[0] `this` slot exactly like an explicit `this` parameter — the
   *  canonical ES5 forms (`function Foo(){ this.a = 1 }` constructors,
   *  `Foo.prototype.m = function(){ return this.a }` methods) are written
   *  without one. */
  fnUsesOwnThis(node: ts.FunctionDeclaration | ts.FunctionExpression): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (n.kind === ts.SyntaxKind.ThisKeyword) { found = true; return; }
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
          ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
          ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n)) return;
      // a class rebinds `this` for EVERYTHING inside it — methods are skipped
      // above, but a field initializer (`f = () => this.v`) or a static block
      // reads the CLASS's this, not this function's. Don't descend.
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
      ts.forEachChild(n, visit);
    };
    if (node.body) visit(node.body);
    return found;
  }

  lowerClosure(ctx: FnCtx, node: FnLike, hint?: string, thisParam = false, classId?: number): number {
    const fnId = this.fnId.get(node)!;
    const selfSym = ts.isFunctionExpression(node) && node.name ? this.symbolOf(node.name) : undefined;
    const selfNeeded = selfSym !== undefined && this.freeVars(node).has(selfSym);
    const savedSelf = selfSym && ctx.cellAccess.get(selfSym);
    let selfCell: number | undefined;
    if (selfSym && selfNeeded) {
      selfCell = this.newLocal(ctx, "reference", "functionSelf", this.bindingIdOf(selfSym));
      const site = this.site++;
      this.recordSite(site, "cell", this.inLoop(node) ? "many" : "once", true, node, true);
      ctx.body.push({ kind: "AllocObject", dst: selfCell, typeId: 0, site, classId: this.cellClassId });
      ctx.cellAccess.set(selfSym, selfCell);
    }
    // An arrow that uses `this` lexically must capture the enclosing function's
    // `this`. Materialize the enclosing `this` into a cell (once per enclosing
    // activation) and capture it under the lexical-this sentinel, so the arrow's
    // body reads `this` from that threaded cell (see lowerFunctionLike).
    const arrowThis = ts.isArrowFunction(node) && this.arrowUsesThis(node as ts.ArrowFunction);
    if (arrowThis) {
      // An arrow that uses `this` lexically captures the enclosing function's
      // `this` through a cell. An arrow body inherits its own lexical-this cell
      // as a parameter (lowerFunctionLike) and threads it on. A method or
      // function materializes `this` into a cell where an arrow is created:
      // one cell per block, as a later arrow may be reached without an earlier
      // block's path (a `switch` whose cases each create an arrow: tsc-ts's
      // build-info reader crashed on a cell never made), and `this` never
      // changes within an activation, so cells of different blocks agree.
      let cell = ctx.cellAccess.get(this.lexicalThisSym);
      const inherited = cell !== undefined && !ctx.ownThisCells?.has(cell);
      if (!inherited) {
        cell = ctx.thisCellOfBody?.get(ctx.body);
        if (cell === undefined) {
          cell = this.newLocal(ctx, "reference", "thisCell");
          const site = this.site++;
          this.labels[site] = `thisCell@${ctx.name}`;
          this.recordSite(site, "cell", this.inLoop(node) ? "many" : "once", true, node, true);
          ctx.body.push({ kind: "AllocObject", dst: cell, typeId: 0, site, classId: this.cellClassId });
          // lowerUnboundThis: a top-level arrow in SCRIPT mode inherits the global
          // object as its lexical this (module top level / strict bodies: undefined).
          const tv = ctx.thisLocal ?? this.lowerUnboundThis(ctx);
          ctx.body.push({ kind: "StoreField", obj: cell, field: this.VALUE, src: tv });
          (ctx.thisCellOfBody ??= new Map()).set(ctx.body, cell);
          (ctx.ownThisCells ??= new Set()).add(cell);
        }
        ctx.cellAccess.set(this.lexicalThisSym, cell);
      }
    }
    this.lowerFunctionLike(node, fnId, false, thisParam, classId); // lift body; reserve `this` as arg0 for accessors
    // When lowered method-like (classId set, e.g. an installed dynamic class
    // method), module-scope bindings are read via their published GLOBALS[] cell
    // (LoadGlobal), NOT captured — so exclude them from the closure captures too,
    // matching lowerFunctionLike's param filter. Otherwise the creating ctor (which
    // holds such a binding as a module cell, not a threaded cell) would pass a
    // missing cell and the body would read garbage.
    const methodLike = classId !== undefined;
    const frees = this.sortedFreeVars(node).filter((s) => !(methodLike && this.moduleCellGlobal.has(s)));
    if (process.env.TSAOT_DEBUG_CELLS)
      console.error(`[closure] ${ctx.name}->${hint ?? fnId} self=${selfSym?.name}:${selfNeeded} captures=${frees.map((s) => `${s.name}:${s === selfSym}:${ctx.cellAccess.has(s)}`).join(",")}`);
    const captures = this.captureSlots(frees).map((slot) => {
      const cell = this.supplySlot(ctx, slot);
      if (cell === undefined)
        this.unsupported(node, `closure cannot capture '${this.slotName(slot)}' (binding is unavailable)`);
      const cellLocal = cell ?? this.newLocal(ctx, "reference", "missingCell");
      return { binding: slot.binding, cell: cellLocal };
    });
    // Append the lexical-this capture (if this arrow uses `this`).
    if (arrowThis) {
      const cell = ctx.cellAccess.get(this.lexicalThisSym)!;
      captures.push({ binding: this.bindingIdOf(this.lexicalThisSym), cell });
    }
    const site = this.site++;
    const dst = this.newLocal(ctx, "reference", hint);
    this.labels[site] = `${hint ?? "closure"}@${ctx.name}`;
    this.recordSite(site, "closure", this.inLoop(node) ? "many" : "once", true, node);
    ctx.body.push({ kind: "AllocClosure", dst, func: fnId, captures, site });
    if (selfSym && selfCell !== undefined) {
      ctx.body.push({ kind: "StoreField", obj: selfCell, field: this.VALUE, src: dst });
      if (savedSelf !== undefined) ctx.cellAccess.set(selfSym, savedSelf);
      else ctx.cellAccess.delete(selfSym);
    }
    return dst;
  }

  /** Run `fn`, capturing all instructions it emits into a fresh body vector
   *  (used to build nested Loop/If bodies). */
  /** True if a block contains a return/throw/break/continue that could transfer
   *  control out of it — used to guard the v1 finally implementation, which does
   *  not yet run finally during such an unwind. */
  blockExitsControl(node: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isReturnStatement(n) || ts.isThrowStatement(n) ||
          ts.isBreakStatement(n) || ts.isContinueStatement(n)) { found = true; return; }
      // don't descend into nested functions (their returns don't escape here)
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    return found;
  }

  /** A condition in test position (`if`, `while`, `for`, `?:`, the operand of a
   *  `!` there): `&&` and `||` lower to short-circuit control flow over a
   *  primitive truth flag instead of a value local the test then boxes and
   *  re-examines (`if (a && b)` tested `truthy(ts_num(b & 1))`; 20.7% of the
   *  compiler project's If conditions have this shape). A `!` negates the
   *  flag; anything else lowers as a value, whose truthiness the If tests as
   *  before. The flag's final truthiness equals the value's: for `a && b` it
   *  is truthy(a) ? truthy(b) : false, for `a || b` truthy(a) ? true : truthy(b). */
  lowerCond(ctx: FnCtx, node: ts.Expression): number {
    {
      const decided = this.constCondValue(node);
      if (decided !== undefined) return this.constBool(ctx, decided);
    }
    if (!this.condFlags) return this.lowerExpr(ctx, node);
    let e: ts.Expression = node;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e) &&
        (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const isAnd = e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
      const flag = this.newLocal(ctx, "primitive");
      const lhs = this.lowerCondFlag(ctx, e.left);
      ctx.body.push({ kind: "Copy", dst: flag, src: lhs });
      const rhsBody = this.captureBody(ctx, () => {
        const rhs = this.lowerCondFlag(ctx, e.right);
        ctx.body.push({ kind: "Copy", dst: flag, src: rhs });
      });
      if (isAnd) ctx.body.push({ kind: "If", cond: flag, thenBody: rhsBody, elseBody: [] });
      else ctx.body.push({ kind: "If", cond: flag, thenBody: [], elseBody: rhsBody });
      return flag;
    }
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = this.lowerCond(ctx, e.operand);
      const dst = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "UnOp", dst, op: "!", operand: inner });
      return dst;
    }
    return this.lowerExpr(ctx, node);
  }
  /** A condition operand's truthiness as a primitive: a logical expression or a
   *  `!` is one already; a value in a primitive local holds a number the test
   *  reads as before; a boxed value goes through `!!` (two negations the C
   *  compiler folds into one truthiness test). */
  lowerCondFlag(ctx: FnCtx, node: ts.Expression): number {
    let e: ts.Expression = node;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if ((ts.isBinaryExpression(e) &&
         (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) ||
        (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken))
      return this.lowerCond(ctx, node);
    const v = this.lowerExpr(ctx, node);
    if (ctx.locals[v] !== undefined && ctx.locals[v].refKind === "primitive") return v;
    const neg = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "UnOp", dst: neg, op: "!", operand: v });
    const flag = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "UnOp", dst: flag, op: "!", operand: neg });
    return flag;
  }
  captureBody(ctx: FnCtx, fn: () => void): any[] {
    const saved = ctx.body;
    const fresh: any[] = [];
    ctx.body = fresh;
    fn();
    ctx.body = saved;
    return fresh;
  }
  // capture a loop/switch body with its kind on the loopStack so break/continue
  // inside it lower correctly.
  captureLoopBody(ctx: FnCtx, kind: string, fn: () => void): any[] {
    if (!ctx.loopStack) ctx.loopStack = [];
    if (!ctx.loopLabels) ctx.loopLabels = [];
    ctx.loopStack.push(kind);
    // consume a pending label (from an enclosing LabeledStatement) for THIS loop
    ctx.loopLabels.push(ctx.pendingLabel);
    ctx.pendingLabel = undefined;
    const body = this.captureBody(ctx, fn);
    ctx.loopStack.pop();
    ctx.loopLabels.pop();
    return body;
  }
  constBool(ctx: FnCtx, b: boolean): number {
    const dst = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "Const", dst, value: { kind: "Bool", value: b } });
    return dst;
  }
  // Array(...) / new Array(...): a single numeric argument is the LENGTH (n holes
  // of undefined); any other argument list is the element list. Shared by the
  // NewExpression and bare-call paths.
  lowerArrayConstruct(ctx: FnCtx, args: ts.Expression[], node: ts.Node, hint?: string): number {
    if (args.length === 1) {
      let isNumeric = false;
      try { isNumeric = (this.checker.getTypeAtLocation(args[0]).flags & ts.TypeFlags.NumberLike) !== 0; } catch { /* not numeric */ }
      if (isNumeric) {
        const nL = this.lowerExpr(ctx, args[0]);
        const dst = this.newLocal(ctx, "reference", hint);
        ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "array.newLength", args: [nL] });
        return dst;
      }
    }
    const site = this.site++;
    this.recordSite(site, "array", this.inLoop(node) ? "many" : "once", false, node);
    const dst = this.newLocal(ctx, "reference", hint);
    ctx.body.push({ kind: "AllocArray", dst, elemType: 0, site });
    for (const el of args) {
      const v = this.lowerExpr(ctx, el);
      ctx.body.push({ kind: "ArrayPush", arr: dst, src: v });
    }
    return dst;
  }

  lowerStmt(ctx: FnCtx, stmt: ts.Statement) {
    if (ts.isBlock(stmt)) {
      // The body block of a loop instantiates its function declarations on
      // every entry (block-scoped declarations in strict code).
      if (stmt.parent && isLoopStatement(stmt.parent)) this.hoistDeclarations(ctx, stmt, true);
      stmt.statements.forEach((s) => this.lowerStmt(ctx, s));
    } else if (ts.isVariableStatement(stmt)) {
      const isLexical = (stmt.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      const isTopLevelScriptVar =
        this.sourceMode === "script" &&
        ts.isSourceFile(stmt.parent) &&
        !(stmt.declarationList.flags & ts.NodeFlags.Let) &&
        !(stmt.declarationList.flags & ts.NodeFlags.Const);
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          const sym = this.symbolOf(d.name);
          if (isTopLevelScriptVar && this.isScriptGlobalVarSymbol(sym, d.name.text)) {
            if (d.initializer) {
              const r = this.lowerExpr(ctx, d.initializer, d.name.text);
              this.storeGlobalObjectProperty(ctx, d.name.text, r);
            }
          } else if (sym && this.hasCaptured(ctx, sym)) {
            // captured binding: its cell or record slot is pre-allocated in the prologue
            if (d.initializer) {
              const r = this.lowerExpr(ctx, d.initializer, d.name.text);
              this.storeCaptured(ctx, sym, r);
            } else if (isLexical) {
              const value = this.newLocal(ctx, "reference");
              ctx.body.push({ kind: "Const", dst: value, value: { kind: "Undef" } });
              this.storeCaptured(ctx, sym, value);
            }
          } else {
            const lid = sym
              ? this.ensureLocal(ctx, sym, this.refKindOf(d.name), d.name.text)
              : this.newLocal(ctx, this.refKindOf(d.name), d.name.text);
            if (d.initializer) {
              const r = this.lowerExpr(ctx, d.initializer, d.name.text);
              ctx.body.push({ kind: "Copy", dst: lid, src: r });
            } else if (isLexical) {
              ctx.body.push({ kind: "Const", dst: lid, value: { kind: "Undef" } });
            }
          }
        } else if (ts.isArrayBindingPattern(d.name) || ts.isObjectBindingPattern(d.name)) {
          // Destructuring: evaluate the initializer once, then bind each element.
          if (!d.initializer) { this.unsupported(d, "destructuring declaration without initializer"); continue; }
          if (ts.isArrayBindingPattern(d.name)) {
            const pat = d.name;
            const source = this.iterablePatternSource(ctx, d.initializer);
            if (source !== undefined && !("drv" in source)) { this.lowerBindingPattern(ctx, pat, source.array); continue; }
            if (source !== undefined && "drv" in source) {
              this.lowerArrayPatternByProtocol(ctx, source.drv, this.bindingPatternElements(ctx, pat));
              continue;
            }
          }
          const src = this.lowerExpr(ctx, d.initializer);
          this.lowerBindingPattern(ctx, d.name, src);
        } else {
          this.unsupported(d, `variable binding form ${ts.SyntaxKind[(d.name as ts.Node).kind]}`);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      this.lowerExpr(ctx, stmt.expression);
    } else if (ts.isReturnStatement(stmt)) {
      if (stmt.expression) {
        let src=this.lowerExpr(ctx, stmt.expression);
        if (ctx.isAsync && ctx.isGenerator) {
          const awaited=this.newLocal(ctx,"reference");
          ctx.body.push({ kind:"Await",dst:awaited,operand:src });
          src=awaited;
        }
        ctx.body.push({ kind: "Return", src });
      } else ctx.body.push({ kind: "Return" });
    } else if (ts.isThrowStatement(stmt)) {
      ctx.body.push({ kind: "Throw", src: this.lowerExpr(ctx, stmt.expression) });
    } else if (ts.isIfStatement(stmt)) {
      const decided = this.constCondValue(stmt.expression);
      if (decided !== undefined) {
        // a build-time constant decides it (`if (__DEV__)`): only the branch taken is compiled
        if (decided) this.lowerStmt(ctx, stmt.thenStatement);
        else if (stmt.elseStatement) this.lowerStmt(ctx, stmt.elseStatement);
      } else {
        const cond = this.lowerCond(ctx, stmt.expression);
        const thenB = this.captureBody(ctx, () => this.lowerStmt(ctx, stmt.thenStatement));
        const elseB = stmt.elseStatement ? this.captureBody(ctx, () => this.lowerStmt(ctx, stmt.elseStatement!)) : [];
        ctx.body.push({ kind: "If", cond, thenBody: thenB, elseBody: elseB });
      }
    } else if (ts.isForStatement(stmt)) {
      // for (init; cond; update) body
      // To make `continue` correct (C continue would skip an update placed at the
      // body end), put the update at the START of cond_body, guarded by a "first
      // iteration" flag so it runs before every iteration except the first. A
      // `continue` in the body jumps to the loop top -> cond_body -> update runs.
      //
      // Per JS spec §14.7.4: if the initializer is `let` and any declared
      // binding is captured by a nested closure (in `cellBindings`), each
      // iteration must get a FRESH cell, so closures captured during iter N
      // observe iter-N's value, not the final value. Detect this and emit a
      // per-iteration cell-allocation structure (the captured-let path).
      // Non-captured `let` and `var` keep the single-cell fast path.
      let capturedLetSym: ts.Symbol | undefined;
      let capturedLetDecl: ts.VariableDeclaration | undefined;
      if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer) &&
          (stmt.initializer.flags & ts.NodeFlags.Let) !== 0 &&
          stmt.initializer.declarations.length === 1) {
        const d = stmt.initializer.declarations[0];
        if (ts.isIdentifier(d.name)) {
          const sym = this.symbolOf(d.name);
          if (sym && this.cellBindings.has(sym)) {
            capturedLetSym = sym;
            capturedLetDecl = d;
          }
        }
      }

      if (capturedLetSym && capturedLetDecl) {
        // CAPTURED-LET PER-ITERATION PATH (closures__capture semantics).
        // Allocate the iter-0 cell directly (bypassing the prologue cell which
        // is dead for this loop), then per cond_body allocate a fresh cell
        // seeded from the previous one's value. cellAccess is overridden inside
        // the loop so reads/writes of `i` (and the update, which is `i++` etc.)
        // route through the live per-iteration cell.
        const sym = capturedLetSym;
        const d = capturedLetDecl;
        const nameTxt = (d.name as ts.Identifier).text;
        const bindingId = this.bindingIdOf(sym);

        // local that always points to the CURRENT iteration's cell
        const cellLocal = this.newLocal(ctx, "reference", `cell_${nameTxt}`, bindingId);

        // 1. allocate iter-0 cell and seed with E_init
        const initSite = this.site++;
        this.labels[initSite] = `cell:${nameTxt}@iter0`;
        this.recordSite(initSite, "cell", "once", true, d, true);
        ctx.body.push({ kind: "AllocObject", dst: cellLocal, typeId: 0, site: initSite, classId: this.cellClassId });
        if (d.initializer) {
          const r = this.lowerExpr(ctx, d.initializer, nameTxt);
          ctx.body.push({ kind: "StoreField", obj: cellLocal, field: this.VALUE, src: r });
        }
        // 2. first-iteration flag
        const firstFlag = this.newLocal(ctx, "primitive");
        const trueK = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst: trueK, value: { kind: "Bool", value: true } });
        ctx.body.push({ kind: "Copy", dst: firstFlag, src: trueK });

        // The per-iteration site is allocated ONCE here (the SAME site id is
        // reused for every iteration's AllocObject; site multiplicity is "many").
        const perSite = this.site++;
        this.labels[perSite] = `cell:${nameTxt}@per_iter`;
        this.recordSite(perSite, "cell", "many", true, d, true);

        // Override cellAccess so any reads/writes of `sym` inside cond/update/body
        // route through cellLocal. Save and restore.
        const savedCell = ctx.cellAccess.get(sym);
        ctx.cellAccess.set(sym, cellLocal);

        let condLocal = -1;
        const condBody = this.captureBody(ctx, () => {
          // if (!first) { prev_val = cellLocal.value; cellLocal = freshCell;
          //               cellLocal.value = prev_val; run_update_via_cellLocal }
          const notFirstBody = this.captureBody(ctx, () => {
            const prevVal = this.newLocal(ctx, "primitive");
            ctx.body.push({ kind: "LoadField", dst: prevVal, obj: cellLocal, field: this.VALUE });
            ctx.body.push({ kind: "AllocObject", dst: cellLocal, typeId: 0, site: perSite, classId: this.cellClassId });
            ctx.body.push({ kind: "StoreField", obj: cellLocal, field: this.VALUE, src: prevVal });
            // run the update — with cellAccess pointing to cellLocal, `i++` etc.
            // becomes LoadField/BinOp/StoreField on the NEW cell.
            if (stmt.incrementor) this.lowerExpr(ctx, stmt.incrementor);
          });
          ctx.body.push({ kind: "If", cond: firstFlag, thenBody: [], elseBody: notFirstBody });
          // first = false
          const falseK = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst: falseK, value: { kind: "Bool", value: false } });
          ctx.body.push({ kind: "Copy", dst: firstFlag, src: falseK });
          // condition
          condLocal = stmt.condition ? this.lowerCond(ctx, stmt.condition) : this.constBool(ctx, true);
        });
        // continue jumps to cond_body where the update is — so a real C continue
        // is correct. Use the "forc" loop kind we already wired up.
        const bodyB = this.captureLoopBody(ctx, "forc", () => {
          this.emitPerIterationBodyCells(ctx, stmt.statement);
          this.lowerStmt(ctx, stmt.statement);
        });
        ctx.body.push({ kind: "Loop", cond: condLocal, condBody, body: bodyB });

        // Restore cellAccess. After the loop, reads of `i` (if any — usually
        // out-of-scope) would fall back to savedCell, but `let` is block-scoped
        // so this is mostly defensive.
        if (savedCell !== undefined) ctx.cellAccess.set(sym, savedCell);
        else ctx.cellAccess.delete(sym);
        return;
      }

      // PLAIN FAST PATH: var, non-captured let, expression initializer.
      if (stmt.initializer) {
        if (ts.isVariableDeclarationList(stmt.initializer)) {
          this.lowerStmt(ctx, ts.factory.createVariableStatement(undefined, stmt.initializer));
        } else this.lowerExpr(ctx, stmt.initializer as ts.Expression);
      }
      // first-iteration flag (only needed when there is an incrementor)
      let firstFlag = -1;
      if (stmt.incrementor) {
        firstFlag = this.newLocal(ctx, "primitive");
        const t = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "Const", dst: t, value: { kind: "Bool", value: true } });
        ctx.body.push({ kind: "Copy", dst: firstFlag, src: t });
      }
      let condLocal = -1;
      const condBody = this.captureBody(ctx, () => {
        if (stmt.incrementor) {
          // if (!first) { update } ; first = false
          const upd = this.captureBody(ctx, () => { this.lowerExpr(ctx, stmt.incrementor!); });
          ctx.body.push({ kind: "If", cond: firstFlag, thenBody: [], elseBody: upd });
          const f = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst: f, value: { kind: "Bool", value: false } });
          ctx.body.push({ kind: "Copy", dst: firstFlag, src: f });
        }
        condLocal = stmt.condition ? this.lowerCond(ctx, stmt.condition) : this.constBool(ctx, true);
      });
      // loop kind "forc" => continue is a real C continue (advance is in cond_body).
      const bodyB = this.captureLoopBody(ctx, stmt.incrementor ? "forc" : "for", () => {
        this.emitPerIterationBodyCells(ctx, stmt.statement);
        this.lowerStmt(ctx, stmt.statement);
        if (!stmt.incrementor) { /* no update */ }
      });
      ctx.body.push({ kind: "Loop", cond: condLocal, condBody, body: bodyB });
    } else if (ts.isWhileStatement(stmt)) {
      let condLocal = -1;
      const condBody = this.captureBody(ctx, () => { condLocal = this.lowerCond(ctx, stmt.expression); });
      const bodyB = this.captureLoopBody(ctx, "while", () => {
        this.emitPerIterationBodyCells(ctx, stmt.statement);
        this.lowerStmt(ctx, stmt.statement);
      });
      ctx.body.push({ kind: "Loop", cond: condLocal, condBody, body: bodyB });
    } else if (false && ts.isForStatement(stmt)) {
      // (superseded by the Loop-emitting branch above)
    } else if (ts.isDoStatement(stmt)) {
      // do BODY while(COND): a single Loop that runs BODY at least once. A `first`
      // flag makes the top-of-loop condition true on the first iteration, then
      // re-evaluates COND each subsequent iteration. Because the loop re-runs
      // condBody on `continue` (re-checking COND), break/continue inside BODY map
      // to the normal "while" loop mechanism — no body duplication, no rejection.
      const first = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst: first, value: { kind: "Num", value: 1 } });
      // condLocal is a reference (boxed): the condition may be a boxed boolean
      // (e.g. `i < 5`), and copying that into a primitive double-typed local would
      // unbox it to NaN (always-truthy -> infinite loop). truthy() handles boxed.
      const condLocal = this.newLocal(ctx, "reference");
      const condBody = this.captureBody(ctx, () => {
        const evalCond = this.captureBody(ctx, () => {
          const cv = this.lowerExpr(ctx, stmt.expression);
          ctx.body.push({ kind: "Copy", dst: condLocal, src: cv });
        });
        const setTrue = this.captureBody(ctx, () => {
          ctx.body.push({ kind: "Const", dst: condLocal, value: { kind: "Bool", value: true } });
        });
        ctx.body.push({ kind: "If", cond: first, thenBody: setTrue, elseBody: evalCond });
        ctx.body.push({ kind: "Const", dst: first, value: { kind: "Num", value: 0 } });
      });
      const bodyB = this.captureLoopBody(ctx, "while", () => {
        this.emitPerIterationBodyCells(ctx, stmt.statement);
        this.lowerStmt(ctx, stmt.statement);
      });
      ctx.body.push({ kind: "Loop", cond: condLocal, condBody, body: bodyB });
    } else if (ts.isSwitchStatement(stmt)) {
      // switch(e){...} with full fall-through semantics. Modeled in two parts:
      //
      //  (1) Compute `matched` = the source-order index of the first case clause
      //      whose expression `=== disc` (case expressions evaluated lazily, in
      //      order, stopping at the first hit — matching JS short-circuit). If no
      //      case matches, `matched` = the default clause's index (if any), else a
      //      sentinel `n` meaning "no clause runs".
      //  (2) A run-once breakable loop that walks all clauses in order; an `active`
      //      flag flips on at clause `matched` and STAYS on, so every following
      //      clause body runs too (fall-through), until a `break` exits the loop.
      //
      // This handles non-empty fall-through, empty-label grouping, and a default
      // clause positioned anywhere — all uniformly.
      const disc = this.lowerExpr(ctx, stmt.expression);
      const clauses = stmt.caseBlock.clauses;
      const n = clauses.length;
      // Fast form (Session 350): when no clause body falls through into the
      // next (every non-empty body but the last ends abruptly), the switch is a
      // direct if/else-if chain inside the run-once loop: each group of labels
      // tests `disc === label` lazily in source order and runs its body; the
      // default group (which must carry no labels of its own) is the final
      // else. No `matched`/`active` bookkeeping, so a 30-case dispatch costs
      // the compares up to its case instead of three passes over every clause.
      // TSAOT_SWITCH_CHAIN=0 keeps the matched/active form.
      if (process.env.TSAOT_SWITCH_CHAIN !== "0") {
        type Group = { labels: ts.Expression[]; hasDefault: boolean; body: readonly ts.Statement[] };
        const groups: Group[] = [];
        let cur: Group = { labels: [], hasDefault: false, body: [] };
        for (const c of clauses) {
          if (ts.isDefaultClause(c)) cur.hasDefault = true; else cur.labels.push(c.expression);
          if (c.statements.length > 0) { cur.body = c.statements; groups.push(cur); cur = { labels: [], hasDefault: false, body: [] }; }
        }
        if (cur.labels.length || cur.hasDefault) groups.push(cur);
        const fast = groups.every((g, i) => i === groups.length - 1 || !this.clauseFallsThrough(g.body)) &&
          groups.every((g) => !(g.hasDefault && g.labels.length > 0)) &&
          groups.filter((g) => g.hasDefault).length <= 1;
        if (fast) {
          const dflt = groups.find((g) => g.hasDefault);
          const chain = groups.filter((g) => !g.hasDefault);
          const loopBody = this.captureLoopBody(ctx, "switch", () => {
            const build = (k: number): any[] => {
              if (k >= chain.length) {
                return dflt ? this.captureBody(ctx, () => dflt.body.forEach((s) => this.lowerStmt(ctx, s))) : [];
              }
              const g = chain[k];
              return this.captureBody(ctx, () => {
                const k0 = this.lowerExpr(ctx, g.labels[0]);
                const eq = this.newLocal(ctx, "primitive");
                ctx.body.push({ kind: "BinOp", dst: eq, op: "===", lhs: disc, rhs: k0 });
                for (let li = 1; li < g.labels.length; li++) {
                  // later labels are evaluated only when the earlier ones missed
                  const miss = this.newLocal(ctx, "primitive");
                  ctx.body.push({ kind: "UnOp", dst: miss, op: "!", operand: eq });
                  const retry = this.captureBody(ctx, () => {
                    const kl = this.lowerExpr(ctx, g.labels[li]);
                    const eq2 = this.newLocal(ctx, "primitive");
                    ctx.body.push({ kind: "BinOp", dst: eq2, op: "===", lhs: disc, rhs: kl });
                    ctx.body.push({ kind: "Copy", dst: eq, src: eq2 });
                  });
                  ctx.body.push({ kind: "If", cond: miss, thenBody: retry, elseBody: [] });
                }
                const thenB = this.captureBody(ctx, () => g.body.forEach((s) => this.lowerStmt(ctx, s)));
                const elseB = build(k + 1);
                ctx.body.push({ kind: "If", cond: eq, thenBody: thenB, elseBody: elseB });
              });
            };
            for (const inst of build(0)) ctx.body.push(inst);
            ctx.body.push({ kind: "Break" });
          });
          const condTrue = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst: condTrue, value: { kind: "Num", value: 1 } });
          ctx.body.push({ kind: "Loop", cond: condTrue, condBody: [], body: loopBody });
          return;
        }
      }
      let dfltIdx = -1;
      for (let i = 0; i < n; i++) if (ts.isDefaultClause(clauses[i])) dfltIdx = i;
      const caseIdxs: number[] = [];
      for (let i = 0; i < n; i++) if (!ts.isDefaultClause(clauses[i])) caseIdxs.push(i);

      // matched: sentinel n (no clause).
      const matched = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst: matched, value: { kind: "Num", value: n } });
      // nested if/else-if testing each case in source order; first hit wins.
      const buildMatch = (k: number): any[] => {
        if (k >= caseIdxs.length) {
          if (dfltIdx >= 0) {
            return this.captureBody(ctx, () => {
              ctx.body.push({ kind: "Const", dst: matched, value: { kind: "Num", value: dfltIdx } });
            });
          }
          return [];
        }
        const ci = caseIdxs[k];
        return this.captureBody(ctx, () => {
          const ki = this.lowerExpr(ctx, (clauses[ci] as ts.CaseClause).expression);
          const eq = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "BinOp", dst: eq, op: "===", lhs: disc, rhs: ki });
          const thenB = this.captureBody(ctx, () => {
            ctx.body.push({ kind: "Const", dst: matched, value: { kind: "Num", value: ci } });
          });
          const elseB = buildMatch(k + 1);
          ctx.body.push({ kind: "If", cond: eq, thenBody: thenB, elseBody: elseB });
        });
      };
      for (const inst of buildMatch(0)) ctx.body.push(inst);

      // run-once breakable loop: active flips on at `matched`, then bodies run
      // with fall-through. A trailing Break ends the single pass.
      const active = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst: active, value: { kind: "Num", value: 0 } });
      const loopBody = this.captureLoopBody(ctx, "switch", () => {
        for (let i = 0; i < n; i++) {
          const idxC = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "Const", dst: idxC, value: { kind: "Num", value: i } });
          const isStart = this.newLocal(ctx, "primitive");
          ctx.body.push({ kind: "BinOp", dst: isStart, op: "===", lhs: matched, rhs: idxC });
          const setActive = this.captureBody(ctx, () => {
            ctx.body.push({ kind: "Const", dst: active, value: { kind: "Num", value: 1 } });
          });
          ctx.body.push({ kind: "If", cond: isStart, thenBody: setActive, elseBody: [] });
          const bodyI = this.captureBody(ctx, () => clauses[i].statements.forEach((s) => this.lowerStmt(ctx, s)));
          ctx.body.push({ kind: "If", cond: active, thenBody: bodyI, elseBody: [] });
        }
        ctx.body.push({ kind: "Break" });
      });
      const condTrue = this.newLocal(ctx, "primitive");
      ctx.body.push({ kind: "Const", dst: condTrue, value: { kind: "Num", value: 1 } });
      ctx.body.push({ kind: "Loop", cond: condTrue, condBody: [], body: loopBody });
    } else if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
      const stack = ctx.loopStack ?? [];
      const labels = ctx.loopLabels ?? [];
      const ctxKind = stack.length ? stack[stack.length - 1] : undefined;
      const isBreak = ts.isBreakStatement(stmt);
      const targetLabel = stmt.label?.text;
      // (a cursor loop steps in its condition, so `continue` is a plain jump)
      const continueSafe = (k: string | undefined) => k === "while" || k === "forof_gen" || k === "forof_cursor" || k === "forof" || k === "forc" || k === "for";
      if (targetLabel !== undefined) {
        // Resolve the labeled target's depth (0 = innermost) by walking loopLabels
        // outward. The exporter's loopLabels and the analyzer's per-loop label
        // stack correspond 1:1, so `depth` indexes the right loop in codegen.
        let depth = -1;
        for (let i = labels.length - 1; i >= 0; i--) {
          if (labels[i] === targetLabel) { depth = labels.length - 1 - i; break; }
        }
        if (depth < 0) {
          this.unsupported(stmt, `labeled ${isBreak ? "break" : "continue"} '${targetLabel}' (target is not an enclosing loop)`);
          return;
        }
        if (depth >= 1) {
          // Multi-level jump. Defer the try/finally interaction (the structured
          // finally path models only one enclosing loop) by rejecting when inside
          // any try-with-finally.
          if (this.insideTryWithFinally(stmt)) {
            this.unsupported(stmt, `labeled ${isBreak ? "break" : "continue"} '${targetLabel}' inside a try/finally (multi-level jump across/within finally not yet modeled)`);
            return;
          }
          if (isBreak) {
            ctx.body.push({ kind: "Break", up: depth });
          } else {
            const targetKind = stack[stack.length - 1 - depth];
            if (!continueSafe(targetKind)) {
              this.unsupported(stmt, `labeled continue '${targetLabel}' to a ${targetKind} loop (increment-skipping not yet modeled)`);
              return;
            }
            ctx.body.push({ kind: "Continue", up: depth });
          }
          return;
        }
        // depth === 0: labels the innermost loop -> same as an unlabeled
        // break/continue; fall through to the handling below.
      }
      if (ctxKind === undefined) {
        this.unsupported(stmt, `${ts.SyntaxKind[stmt.kind]} outside any loop/switch`);
      } else if (ctxKind === "switch") {
        if (isBreak) ctx.body.push({ kind: "Break" });
        else {
          let depth = 1;
          while (stack[stack.length - 1 - depth] === "switch") depth++;
          const targetKind = stack[stack.length - 1 - depth];
          if (continueSafe(targetKind)) ctx.body.push({ kind: "Continue", up: depth });
          else this.unsupported(stmt, "continue without an enclosing iteration statement");
        }
      } else if (ctxKind === "do") {
        this.unsupported(stmt, `${ts.SyntaxKind[stmt.kind]} in do-while (not yet modeled)`);
      } else if (isBreak) {
        ctx.body.push({ kind: "Break" });
      } else {
        // Every supported loop advances before the user body or in condBody.
        if (continueSafe(ctxKind)) ctx.body.push({ kind: "Continue" });
        else this.unsupported(stmt, `continue in ${ctxKind} loop (increment-skipping not yet modeled)`);
      }
    } else if (ts.isForOfStatement(stmt)) {
      // for await (const x of E): drive an async generator/iterable with awaited
      // .next(): const g=E; while(true){ const r=await g.next(); if(r.done)break;
      // x=r.value; BODY }. Each loop has its own g/r locals (nested-safe).
      if (stmt.awaitModifier) {
        if (!ctx.isAsync && !ctx.isGenerator) {
          this.unsupported(stmt, "for await used outside an async function");
          return;
        }
        const drv = this.resolveIterator(ctx, stmt.expression, { forceAsync: true });
        if (!drv) { this.unsupported(stmt, "for-await over a non-async-iterable"); return; }
        this.lowerDrivenForLoop(ctx, stmt.initializer, stmt.statement, drv);
        return;
      }
      // for-of over any iterable/iterator (our generator, custom [Symbol.iterator]
      // class, or an object exposing next()). Driven by the shared resolveIterator;
      // arrays/strings fall through to the index loop below.
      // for-of over a Map/Headers yields [key,value] pairs; over a Set yields
      // elements.
      // Drive Map/Set iterators directly so mutations during iteration remain
      // visible. Headers still uses its existing array representation.
      const cursorTarget = this.forOfCursorTarget(stmt.expression);
      if (cursorTarget) { this.lowerCursorForLoop(ctx, stmt.initializer, stmt.statement, cursorTarget); return; }
      const rkForOf = this.builtinReceiverKind(stmt.expression);
      if (rkForOf === "map" || rkForOf === "set") {
        const recv = this.lowerExpr(ctx, stmt.expression);
        const iterator = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "CallBuiltin", dst: iterator, builtin: rkForOf === "map" ? "map.entries" : "set.values", recv, args: [] });
        const method = this.internName("next");
        const methodField = this.internField("next");
        this.lowerDrivenForLoop(ctx, stmt.initializer, stmt.statement, { step: () => {
          const dst = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "Call", dst, recv: iterator, callee: { kind: "Method", recvClass: 0xffffffff, method, methodField, recvStable: false }, args: [] });
          return dst;
        } });
        return;
      }
      // `for (... of arr.values() / arr.keys() / arr.entries())` over a built-in
      // array: the array iterator reads the array live (each step tests the index
      // against the current length), so walk the array itself with the index
      // loop, binding the element, the index or the [index, element] pair.
      const arrIter = this.arrayIteratorForOfTarget(stmt.expression);
      if (arrIter) {
        const arrL = this.forOfArraySource(ctx, this.lowerExpr(ctx, arrIter.arr));
        this.lowerArrayIndexForOf(ctx, stmt.initializer, stmt.statement, arrL, false, arrIter.mode);
        return;
      }
      const exprIsBuiltinArray2 = this.builtinReceiverKind(stmt.expression) === "array";
      if (!exprIsBuiltinArray2) {
        const drv = this.resolveIterator(ctx, stmt.expression, {});
        if (drv) { this.lowerDrivenForLoop(ctx, stmt.initializer, stmt.statement, drv); return; }
      }
      // A value whose type settles neither an array nor a string nor a known
      // iterable (any, unknown, a union, a type parameter): the protocol is
      // chosen at run time (an array still walks by index).
      const forOfKind = this.builtinReceiverKind(stmt.expression);
      if (this.forOfDynamicEnabled && forOfKind !== "array" && forOfKind !== "string") {
        this.lowerDynamicForOf(ctx, stmt.initializer, stmt.statement, stmt.expression);
        return;
      }
      // for (const x of arr) body  ->  let i=0; while(i<arr.length){ x=arr[i]; body; i++ }
      const iterIsString = forOfKind === "string";
      const arr0 = this.lowerExpr(ctx, stmt.expression);
      const arr = iterIsString ? arr0 : this.forOfArraySource(ctx, arr0);
      this.lowerArrayIndexForOf(ctx, stmt.initializer, stmt.statement, arr, iterIsString);
    } else if (ts.isForInStatement(stmt)) {
      // Snapshot enumerable string keys across the full prototype chain,
      // deduplicating shadowed names as EnumerateObjectProperties requires.
      //   let i=0; while(i<keys.length){ k = keys[i]; body; i++ }
      const obj = this.lowerExpr(ctx, stmt.expression);
      const keys = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "CallBuiltinStatic", dst: keys, builtin: "object.forInKeys", args: [obj] });
      this.lowerArrayIndexForOf(ctx, stmt.initializer, stmt.statement, keys, false);
    } else if (ts.isLabeledStatement(stmt)) {
      // A label on a loop: record it so an immediately-enclosed `break L` /
      // `continue L` targeting THIS loop maps to a plain break/continue. Labels
      // that jump to an *outer* loop from a nested one are not yet modeled.
      const label = stmt.label.text;
      const inner = stmt.statement;
      if (ts.isIterationStatement(inner, false)) {
        const prev = ctx.pendingLabel;
        ctx.pendingLabel = label;
        this.lowerStmt(ctx, inner);
        ctx.pendingLabel = prev;
      } else {
        // label on a non-loop (e.g. block): only safe if the label is unused.
        this.lowerStmt(ctx, inner);
      }
    } else if (ts.isTryStatement(stmt)) {
      const hasFinally = !!stmt.finallyBlock;
      // Both non-coroutine (emit_plain_finally) and coroutine (the flat
      // completion-record FinallyAbrupt path) now support return/break/continue/
      // throw escaping a try/catch with finally. Nothing to reject here.
      void hasFinally;
      const tryBody = this.captureBody(ctx, () => this.lowerStmt(ctx, stmt.tryBlock));
      let catchVar: number | undefined = undefined;
      let catchBody: any[] = [];
      if (stmt.catchClause) {
        const cc = stmt.catchClause;
        if (cc.variableDeclaration) {
          if (!ts.isIdentifier(cc.variableDeclaration.name)) {
            this.unsupported(cc, "destructured catch binding (only `catch (e)` supported)");
            return;
          }
          const sym = this.symbolOf(cc.variableDeclaration.name);
          catchVar = sym ? this.ensureLocal(ctx, sym, "reference", cc.variableDeclaration.name.text)
                         : this.newLocal(ctx, "reference");
        }
        catchBody = this.captureBody(ctx, () => this.lowerStmt(ctx, cc.block));
      }
      const finallyBody = hasFinally
        ? this.captureBody(ctx, () => this.lowerStmt(ctx, stmt.finallyBlock!))
        : [];
      ctx.body.push({ kind: "TryCatch", tryBody, catchVar: catchVar ?? null, catchBody, finallyBody });
    } else if (ts.isFunctionDeclaration(stmt) && !stmt.body) {
      // Overload signatures and ambient declarations are erased. Only the
      // implementation owns code, a function value, and capture parameters.
    } else if (ts.isFunctionDeclaration(stmt) && stmt.body && !stmt.name) {
      // `export default function () {...}`: the anonymous declaration is the module's default export,
      // its closure bound to the export's symbol (an importer's `import f from "./m"` resolves to it)
      const v = this.lowerClosure(ctx, stmt as unknown as ts.FunctionExpression, undefined);
      this.bindDefaultExport(ctx, stmt, v);
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && !ts.isIdentifier(stmt.expression)) {
      // `export default <expression>`: the value bound to the default export's symbol in __module_init
      const v = this.lowerExpr(ctx, stmt.expression);
      this.bindDefaultExport(ctx, stmt, v);
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause !== undefined && ts.isNamespaceExport(stmt.exportClause) && stmt.moduleSpecifier !== undefined && ts.isIdentifier(stmt.exportClause.name)) {
      // `export * as ns from "m"`: the namespace object of m, bound as this module's `ns` (as `import * as ns` is)
      this.materializeNamespace(ctx, stmt.moduleSpecifier, stmt.exportClause.name, stmt);
    } else if (ts.isFunctionDeclaration(stmt) && stmt.body && stmt.name) {
      // Step D: if this function was hoisted at the prologue (the common case
      // for any function declaration in a block), the binding already exists —
      // the textual occurrence is a no-op (JS semantics: function declarations
      // are fully hoisted, not re-bound at their textual position).
      if (ctx.hoistedFns.has(stmt)) return;
      // nested function declaration: lift it, and bind its closure to the name
      const sym = this.symbolOf(stmt.name);
      const dst = this.lowerClosure(ctx, stmt, stmt.name.text);
      if (sym && !this.hasCaptured(ctx, sym)) this.ensureLocalAlias(ctx, sym, dst);
    } else if (ts.isClassDeclaration(stmt)) {
      // Class declarations create one constructor value at the declaration's
      // runtime position and bind that value lexically. Identifier reads then load
      // the stored binding, preserving constructor identity (`C === C`).
      const csym = stmt.name ? this.symbolOf(stmt.name) : undefined;
      const cid = csym ? this.classSymToId.get(csym) : undefined;
      if (cid === undefined && stmt.name && csym) {
        // `class D extends Parent {}` over a runtime value: a derived constructor bound like a const
        const base = dynamicBaseEmptyClass(stmt, this.checker);
        if (base) {
          const v = this.lowerDynamicDerivedClass(ctx, base, stmt.name.text);
          if (this.hasCaptured(ctx, csym)) this.storeCaptured(ctx, csym, v); else this.ensureLocalAlias(ctx, csym, v);
          return;
        }
      }
      let classValue: ClassValueEmit | undefined;
      if (stmt.name && csym && cid !== undefined) {
        classValue = this.emitClassValue(ctx, cid, stmt.name.text, stmt, false);
        if (classValue !== undefined) {
          if (this.hasCaptured(ctx, csym)) {
            this.storeCaptured(ctx, csym, classValue.local);
          } else {
            this.ensureLocalAlias(ctx, csym, classValue.local);
          }
        }
      }
      // Step F: at the declaration's source position, run __static_init (if it has
      // statics) so static initializers observe earlier bindings and the class
      // binding initialized above.
      if (cid !== undefined && this.classStaticGlobal.has(cid)) {
        const initFnId = this.staticInits.find((s) => s.classId === cid)?.fnId;
        if (initFnId !== undefined) {
          ctx.body.push({ kind: "Call", dst: this.newLocal(ctx, "reference"),
            callee: { kind: "Direct", func: initFnId }, args: this.staticInitArgs(ctx, cid, classValue) });
        }
      }
      if (cid !== undefined && classValue?.classValue) {
        this.linkClassValueStaticContainer(ctx, classValue.local, cid);
      }
    } else if (ts.isEnumDeclaration(stmt)) {
      this.lowerEnumDeclaration(ctx, stmt);
    } else if (ts.isModuleDeclaration(stmt)) {
      // Value namespace -> runtime object (standalone) or static-container members
      // (merged with a same-named class). lowerModuleDeclaration handles both by
      // choosing the target. Pure type namespaces are erased.
      if (ts.isIdentifier(stmt.name) && this.isValueNamespace(stmt)) {
        this.lowerModuleDeclaration(ctx, stmt);
      }
    } else if (ts.isInterfaceDeclaration(stmt) ||
               ts.isTypeAliasDeclaration(stmt) ||
               stmt.kind === ts.SyntaxKind.EmptyStatement ||
               stmt.kind === ts.SyntaxKind.DebuggerStatement) {
      // erased (types) or no-op
    } else if (ts.isImportDeclaration(stmt) && this.isNamespaceImportStmt(stmt)) {
      // `import * as ns` builds a runtime namespace object (in __module_init).
      this.lowerNamespaceImport(ctx, stmt);
    } else if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) ||
               ts.isExportAssignment(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      // Module linkage: erase (bundler symbol-linking resolves refs) / loud-reject
      // the unsupported forms. Replaces the previous silent skip.
      this.tryHandleLinkage(stmt);
    } else {
      this.unsupported(stmt, `statement ${ts.SyntaxKind[stmt.kind]}`);
    }
  }
  ensureLocalAlias(ctx: FnCtx, sym: ts.Symbol, local: number) {
    ctx.localOfSymbol.set(sym, local);
    (ctx.storageLocals ??= new Set()).add(local);
  }
  /** The `default` export symbol of the module a declaration is in (a default export that is a value). */
  private defaultExportSymbolOf(decl: ts.Node): ts.Symbol | undefined {
    const sf = decl.getSourceFile();
    const modSym = this.checker.getSymbolAtLocation(sf) ?? (sf as unknown as { symbol?: ts.Symbol }).symbol;
    if (!modSym) return undefined;
    for (const e of this.checker.getExportsOfModule(modSym)) if (e.name === "default") return e;
    return undefined;
  }
  /** Whether a statement is a default export carrying a value: `export default <expression>` (not a bare
   *  name, which aliases a binding) or an anonymous `export default function`. */
  private isValueDefaultExport(stmt: ts.Node): boolean {
    return (ts.isExportAssignment(stmt) && !stmt.isExportEquals && !ts.isIdentifier(stmt.expression)) ||
      (ts.isFunctionDeclaration(stmt) && stmt.body !== undefined && stmt.name === undefined);
  }
  /** The binding of a namespace statement (`import * as name from` or `export * as name from`), else undefined. */
  private namespaceBindingName(stmt: ts.Node): ts.Identifier | undefined {
    if (ts.isImportDeclaration(stmt) && this.isNamespaceImportStmt(stmt)) return (stmt.importClause!.namedBindings as ts.NamespaceImport).name;
    if (ts.isExportDeclaration(stmt) && stmt.exportClause !== undefined && ts.isNamespaceExport(stmt.exportClause) && stmt.moduleSpecifier !== undefined && ts.isIdentifier(stmt.exportClause.name)) return stmt.exportClause.name;
    return undefined;
  }
  /** Binds a default export's value to its symbol in __module_init (a cell when importers capture it). */
  private bindDefaultExport(ctx: FnCtx, decl: ts.Node, v: number): void {
    const sym = this.defaultExportSymbolOf(decl);
    if (!sym) { this.unsupported(decl, "export default: the module's default export symbol was not found"); return; }
    if (this.hasCaptured(ctx, sym)) this.storeCaptured(ctx, sym, v);
    else this.ensureLocalAlias(ctx, sym, v);
  }

  // Step D: hoist `function` and `var` declarations to the function prologue.
  // Collects hoistable decls in `body` (descending into blocks/loops/if/try,
  // but NOT into nested function or class bodies — those have their own scope),
  // then binds functions (as closures, callable before their textual site) and
  // initializes `var` slots to undefined. Functions hoisted here are recorded in
  // ctx.hoistedFns so their textual FunctionDeclaration is a no-op when reached.
  hoistDeclarations(ctx: FnCtx, body: ts.Block, loopBody = false) {
    const fnDecls: ts.FunctionDeclaration[] = [];
    const varNames: ts.Identifier[] = [];
    // `var` bindings are function-scoped: collected through every nested block
    // and loop (not into other functions) and hoisted once, at the prologue.
    const collectVars = (n: ts.Node) => {
      if (isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
      // an ambient `var` (`declare var`, `declare global`) binds nothing here:
      // the environment provides it on the global object
      if (n.flags & AMBIENT_NODE_FLAG) return;
      if (ts.isVariableStatement(n)) {
        const flags = n.declarationList.flags;
        if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const))
          for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) varNames.push(d.name);
      }
      n.forEachChild(collectVars);
    };
    const collect = (n: ts.Node) => {
      if (n.flags & AMBIENT_NODE_FLAG) return;
      // A function DECLARATION at this level is hoisted (record it, then do NOT
      // descend — its body is a separate scope). Check this BEFORE the generic
      // function-like early-return, since a FunctionDeclaration is function-like.
      if (ts.isFunctionDeclaration(n) && n.body && n.name) {
        fnDecls.push(n);
        return;
      }
      // A function declaration inside a loop body is block-scoped: it is
      // instantiated at every entry of that block (lowerStmt hoists it when it
      // lowers the loop's block), so the prologue takes only the vars from it.
      if (isLoopStatement(n)) { if (!loopBody) collectVars(n); return; }
      // Do not descend into other nested function-likes (expressions, arrows,
      // methods) or class bodies: their inner var/function declarations hoist to
      // THEIR scope, not ours.
      if (isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
      if (ts.isVariableStatement(n)) {
        const flags = n.declarationList.flags;
        const isVar = !(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const);
        if (isVar) {
          for (const d of n.declarationList.declarations) {
            if (ts.isIdentifier(d.name)) varNames.push(d.name);
          }
        }
      }
      n.forEachChild(collect);
    };
    body.statements.forEach(collect);

    // Lazy closure values are registered for the whole block before any body
    // is lowered: a sibling lowered earlier in lexical order may read a later
    // declaration's value (`tryParse(parseJSDocLinkPrefix)`), and that read
    // must find the lazy storage, not a bare record field.
    const lazyHere = new Set<ts.Symbol>();
    if (this.lazyFnValues) {
      for (const fd of fnDecls) {
        const sym = this.symbolOf(fd.name!);
        if (!sym || this.isScriptGlobalVarSymbol(sym, fd.name!.text) || this.functionValueGlobal.has(sym)) continue;
        const directOnly = this.lazyFnDecls && !this.fnValueUsed.has(sym) && !this.hasCaptured(ctx, sym);
        if (directOnly) continue;
        this.lazyFnValueSyms.add(sym);
        lazyHere.add(sym);
        if (!this.hasCaptured(ctx, sym)) {
          const lid = this.ensureLocal(ctx, sym, "reference", fd.name!.text);
          ctx.body.push({ kind: "Const", dst: lid, value: { kind: "Undef" } });
        }
      }
    }
    // Hoist functions first (JS: function declarations win over var of same name).
    for (const fd of fnDecls) {
      const sym = this.symbolOf(fd.name!);
      if (!sym) continue;
      // A nested declaration that is only ever called directly needs no closure
      // value at all: direct calls pass the scope record. Skip the allocation
      // but still lower the body here, in lexical order (see ensureNestedLowered).
      if (this.lazyFnDecls && !this.fnValueUsed.has(sym) &&
          !this.isScriptGlobalVarSymbol(sym, fd.name!.text) &&
          !this.hasCaptured(ctx, sym) && !this.functionValueGlobal.has(sym)) {
        this.lowerFunctionLike(fd, this.fnId.get(fd)!, false);
        ctx.hoistedFns.add(fd);
        continue;
      }
      // Lazy closure value: lower the body now; the storage was left undefined
      // above and the first value use of this activation allocates the
      // closure (lazyFunctionValue).
      if (lazyHere.has(sym)) {
        this.lowerFunctionLike(fd, this.fnId.get(fd)!, false);
        ctx.hoistedFns.add(fd);
        continue;
      }
      // If captured by a nested closure, it lives in a cell (already allocated);
      // store the closure value into the cell. Otherwise bind a local alias.
      const dst = this.lowerClosure(ctx, fd, fd.name!.text);
      if (this.isScriptGlobalVarSymbol(sym, fd.name!.text)) {
        this.storeGlobalObjectProperty(ctx, fd.name!.text, dst);
      } else if (this.hasCaptured(ctx, sym)) {
        this.storeCaptured(ctx, sym, dst);
      } else {
        this.ensureLocalAlias(ctx, sym, dst);
      }
      const fgid = this.functionValueGlobal.get(sym);
      if (fgid !== undefined) ctx.body.push({ kind: "StoreGlobal", gref: fgid, src: dst });
      ctx.hoistedFns.add(fd);
    }
    // Hoist `var` bindings: initialize to undefined (unless already a cell that
    // a function hoist filled, or a param). Reads before assignment see undefined.
    // (A loop body's hoist handles its function declarations only: the vars
    // persist across iterations and were initialized at the prologue.)
    if (loopBody) return;
    for (const id of varNames) {
      const sym = this.symbolOf(id);
      if (!sym) continue;
      if (this.isScriptGlobalVarSymbol(sym)) {
        this.declareGlobalVarProperty(ctx, id.text);
        continue;
      }
      if (this.hasCaptured(ctx, sym)) {
        // captured var: its cell or record field already starts as undefined.
        continue;
      }
      // plain local: ensure it exists and init to undefined.
      const lid = this.ensureLocal(ctx, sym, this.refKindOf(id), id.text);
      const u = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
      ctx.body.push({ kind: "Copy", dst: lid, src: u });
    }
  }

  /** The context-derived name a function's C symbol carries (`fn_<id>_<name>`; docs/agent_workflow.md,
   *  "Profiling a native build"): a class member is `Dep_track` / `Dep_get_dirty` / `Dep_ctor`, a named
   *  function its name, and an anonymous function the binding or property it is assigned to, the callee
   *  it is passed to (`reactivityRound_map`) or its enclosing function (`track_arrow`). The id keeps the
   *  symbol unique; this only has to read well in a profile or a backtrace. The JS-visible `fn.name`
   *  is the IR function's `name`, not this. */
  private debugNames = new Map<ts.Node, string>();
  debugNameOf(node: ts.Node): string {
    const cached = this.debugNames.get(node);
    if (cached !== undefined) return cached;
    let raw: string;
    try { raw = this.debugNameRaw(node); } catch { raw = "anon"; }
    const name = raw.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+$/, "").slice(0, 64) || "anon";
    this.debugNames.set(node, name);
    return name;
  }
  /** The static text of a member's key: an identifier, a string or number literal, a private name,
   *  or a well-known symbol (`[Symbol.iterator]`); undefined for any other computed key. */
  private memberKeyName(nm: ts.PropertyName | undefined): string | undefined {
    if (!nm) return undefined;
    if (ts.isIdentifier(nm) || ts.isPrivateIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm) ||
        ts.isNoSubstitutionTemplateLiteral(nm)) return nm.text;
    if (ts.isComputedPropertyName(nm) && ts.isPropertyAccessExpression(nm.expression) &&
        ts.isIdentifier(nm.expression.expression) && nm.expression.expression.text === "Symbol") {
      return `[Symbol.${nm.expression.name.text}]`;
    }
    return undefined;
  }
  private debugNameRaw(node: ts.Node): string {
    const owner = (): string => {
      const p = node.parent;
      if (p && ts.isClassLike(p)) return p.name?.text ?? "class";
      return this.enclosingDebugName(node);   // an object-literal member: its enclosing function
    };
    if (ts.isConstructorDeclaration(node)) return `${owner()}_ctor`;
    if (ts.isMethodDeclaration(node)) return `${owner()}_${this.memberKeyName(node.name) ?? "method"}`;
    if (ts.isGetAccessorDeclaration(node)) return `${owner()}_get_${this.memberKeyName(node.name) ?? "key"}`;
    if (ts.isSetAccessorDeclaration(node)) return `${owner()}_set_${this.memberKeyName(node.name) ?? "key"}`;
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
    // an anonymous function: the binding, property or callee it is handed to, else its enclosing function
    const kind = ts.isArrowFunction(node) ? "arrow" : "fn";
    let p: ts.Node | undefined = node.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) ||
                 ts.isNonNullExpression(p))) p = p.parent;
    if (p) {
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      if (ts.isPropertyAssignment(p)) return `${this.enclosingDebugName(node)}_${this.memberKeyName(p.name) ?? kind}`;
      if (ts.isPropertyDeclaration(p)) {
        const c = p.parent;
        return `${(ts.isClassLike(c) && c.name?.text) || "class"}_${this.memberKeyName(p.name) ?? kind}`;
      }
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(p.left)) return p.left.text;
        if (ts.isPropertyAccessExpression(p.left)) return `${this.enclosingDebugName(node)}_${p.left.name.text}`;
      }
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
        const callee = p.expression;
        const cn = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        if (cn) return `${this.enclosingDebugName(node)}_${cn}`;
      }
    }
    return `${this.enclosingDebugName(node)}_${kind}`;
  }
  private enclosingDebugName(node: ts.Node): string {
    const isBody = (n: ts.Node) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) ||
      ts.isConstructorDeclaration(n) || ts.isClassStaticBlockDeclaration(n);
    let p = node.parent;
    while (p && !isBody(p)) p = p.parent;
    if (!p) return "top";
    if (ts.isClassStaticBlockDeclaration(p)) {
      const c = p.parent;
      return `${(ts.isClassLike(c) && c.name?.text) || "class"}_static`;
    }
    return this.debugNameOf(p);
  }
  /** `file:line:col` of a function's source (the file relative to the working directory), carried
   *  by the IR function and written as a comment at the head of its C body; undefined for a
   *  synthesized node. */
  private srcFileNames = new Map<string, string>();
  srcOf(node: ts.Node): string | undefined {
    try {
      const sf = node.getSourceFile();
      if (!sf || node.pos < 0) return undefined;
      let rel = this.srcFileNames.get(sf.fileName);
      if (rel === undefined) {
        rel = path.relative(process.cwd(), sf.fileName).replace(/\\/g, "/");
        if (rel.startsWith("..")) rel = sf.fileName;
        this.srcFileNames.set(sf.fileName, rel);
      }
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return `${rel}:${lc.line + 1}:${lc.character + 1}`;
    } catch {
      return undefined;
    }
  }
  lowerFunctionLike(node: FnLike, fnId: number, isExported: boolean, thisParam = false, classId?: number, staticThis = false) {
    // Idempotent: each fnId is a distinct function body, lowered exactly once. A
    // node may reach here twice (a field-initializer/installed-method closure that
    // is re-emitted per construction site); skip the duplicate so `this.functions`
    // never holds two same-id entries (which would emit a C redefinition).
    if (this.loweredFnIds.has(fnId)) return;
    this.loweredFnIds.add(fnId);
    this.curModuleFile = node.getSourceFile().fileName;
    this.noteFnModule(fnId);
    // A TypeScript explicit `this` parameter (function f(this: T, ...)) is not a
    // real positional argument: it only declares the type of `this`. Treat it like
    // the accessor/method `this` slot (args[0]) so call/apply/bind inject thisArg
    // there, and skip it from the regular parameter loop below.
    const params0 = (node as ts.FunctionLikeDeclaration).parameters;
    const hasExplicitThis = !!params0 && params0.length > 0 &&
      ts.isIdentifier(params0[0].name) && params0[0].name.text === "this";
    if (hasExplicitThis) thisParam = true;
    // ES5 dynamic `this`: a plain function declaration/expression whose body
    // reads its own `this` gets the same args[0] slot as an explicit `this`
    // parameter (ES5 constructors/prototype methods are written without one).
    // Every call ABI agrees on the slot: direct calls prepend undefined
    // (funcTakesThisIds), indirect calls go through ts_call_value (runtime
    // injects undefined for takes_this callees), method dispatch and
    // ts_construct already pass the receiver at args[0].
    // The synthesized __module_init is exempt: it hosts TOP-LEVEL `this`,
    // which is lexical, not a dynamic function this — binding it to args[0]
    // would read past the empty argv. lowerUnboundThis resolves it instead
    // (script mode: the global object; module mode: undefined).
    if (!thisParam && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
        node !== (this.moduleInitNode as unknown as FnLike) &&
        this.fnUsesOwnThis(node)) {
      thisParam = true;
    }
    // async functions: lowered to return a Promise. Generators: lowered to a
    // state machine returning a generator object, driven by .next() / for-of.
    const mods = (node as ts.FunctionLikeDeclaration).modifiers;
    const isAsync = !!mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const isGenerator = !!(node as any).asteriskToken;
    if (isAsync && isGenerator) {
      // async generator (async function*) — supported via the AsyncGenerator
      // state-machine mode. Falls through to normal lowering with both flags set.
    }
    const name =
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name
        ? node.name.text
        : ts.isArrowFunction(node)
        ? `arrow${fnId}`
        : `fn${fnId}`;
    const ctx: FnCtx = {
      id: fnId,
      name,
      params: [],
      locals: [],
      body: [],
      localOfSymbol: new Map(),
      cellAccess: new Map(),
      isExported,
      isAsync,
      isGenerator,
      selfFunctionSymbol:
        ts.isFunctionExpression(node) && node.name ? this.symbolOf(node.name) : undefined,
      hoistedFns: new Set(),
    };

    // Parameter layout. ts_call prepends a closure's captured cells BEFORE the
    // caller's actual args, so for a closure that also takes `this` (an accessor
    // function expression that captures), the order must be [cells..., this, real
    // params]. For a non-capturing method it reduces to [this, real params] (the
    // usual recv-at-0 convention). So: cells first when present, then `this`.
    // Step E: a method (dispatched via vtable, fixed ABI) cannot receive module
    // cells as leading params. Such bindings are published in GLOBALS[] and read
    // via LoadGlobal inside the body, so exclude them from this function's cell
    // params when it's a method/accessor/ctor (classId set).
    const isMethodLike = classId !== undefined;
    const freeVars = this.sortedFreeVars(node).filter(
      (s) => !(isMethodLike && this.moduleCellGlobal.has(s)),
    );
    // An arrow using `this` lexically receives the enclosing `this` as a trailing
    // cell capture (appended after freeVar cells in lowerClosure, matching order).
    const arrowThis = ts.isArrowFunction(node) && this.arrowUsesThis(node as ts.ArrowFunction);
    const hasCaptures = freeVars.length > 0 || arrowThis;
    const emitThis = () => {
      if (thisParam) {
        const tid = this.newLocal(ctx, "reference", "this");
        ctx.params.push(tid);
        ctx.thisLocal = tid;
        ctx.currentClass = classId;
      } else if (staticThis) {
        // Static method or static accessor: `this` is a real parameter (arg0),
        // bound at the call site to the static "class object" (the proto-linked
        // static container, or whatever `this` bind/call/apply supplies). This is
        // takes_this=1, so the runtime injects the receiver. currentClass is NOT
        // set: the receiver is a plain object, so `this.x`/`this.m()` use the
        // generic ts_get/ts_set/dynamic-dispatch paths (proto-walking the
        // container chain), matching JS — not the typed-struct (Class{cid}) layout.
        const tid = this.newLocal(ctx, "reference", "this");
        ctx.params.push(tid);
        ctx.thisLocal = tid;
        // Record the defining class so `super.X` resolves to the parent's static
        // member (this is NOT used for `this.X`, which stays generic on thisLocal).
        ctx.staticClass = classId;
      }
    };
    const captureSlots = this.captureSlots(freeVars);
    const emitCells = () => {
      for (const slot of captureSlots) this.bindCaptureParam(ctx, slot);
      if (arrowThis) {
        // trailing lexical-this cell param; body reads `this` from its VALUE.
        const lid = this.newLocal(ctx, "reference", "cell_this", this.bindingIdOf(this.lexicalThisSym));
        ctx.cellAccess.set(this.lexicalThisSym, lid);
        ctx.params.push(lid);
        this.markCellParam(ctx, lid);
        const tid = this.newLocal(ctx, "reference", "this");
        ctx.body.push({ kind: "LoadField", dst: tid, obj: lid, field: this.VALUE });
        ctx.thisLocal = tid;
      }
    };
    if (hasCaptures) { emitCells(); emitThis(); }   // [cells..., this]
    else { emitThis(); }                            // [this] (no cells)
    ctx.captureCount = hasCaptures ? captureSlots.length + (arrowThis ? 1 : 0) : 0;
    if (!ts.isArrowFunction(node)) ctx.argumentsOffset = ctx.params.length;
    // 2. real parameters
    const parameterBindings: { node: ts.ParameterDeclaration; local: number }[] = [];
    for (const p of node.parameters) {
      // skip the explicit `this` parameter — already bound as thisLocal via emitThis.
      if (ts.isIdentifier(p.name) && p.name.text === "this") continue;
      // a callback parameter bound by specialization has no local: its
      // references name the function (the call site drops the argument)
      if (this.callbackSubst && ts.isIdentifier(p.name)) {
        const ps = this.symbolOf(p.name);
        if (ps && this.callbackSubst.has(ps)) continue;
      }
      if (p.dotDotDotToken) {
        // rest parameter: a normal local that the callee fills with an array of
        // the surplus args. Must be a simple identifier (no destructured rest).
        if (!ts.isIdentifier(p.name)) { this.unsupported(p, "destructured rest parameter"); continue; }
        const psym = this.symbolOf(p.name);
        const lid = psym ? this.ensureLocal(ctx, psym, "reference", p.name.text)
                         : this.newLocal(ctx, "reference", p.name.text);
        ctx.params.push(lid);
        ctx.restParam = lid;
        parameterBindings.push({ node: p, local: lid });
        continue;
      }
      if (!ts.isIdentifier(p.name)) {
        // destructuring parameter: bind from a synthetic param local
        if (ts.isArrayBindingPattern(p.name) || ts.isObjectBindingPattern(p.name)) {
          const plid = this.newLocal(ctx, "reference", "param");
          ctx.params.push(plid);
          parameterBindings.push({ node: p, local: plid });
          continue;
        }
        this.unsupported(p, `parameter binding form ${ts.SyntaxKind[(p.name as ts.Node).kind]}`);
        continue;
      }
      const psym = this.symbolOf(p.name);
      // A parameter with a default initializer may hold the default (any type) when
      // the argument is omitted, so it must NOT be int-unboxed — force a reference
      // local so `param === undefined` is observable and the default can be stored.
      const pkind = p.initializer ? "reference" : this.refKindOf(p.name);
      const lid = psym
        ? this.ensureLocal(ctx, psym, pkind, p.name.text)
        : this.newLocal(ctx, pkind, p.name.text);
      ctx.params.push(lid);
      parameterBindings.push({ node: p, local: lid });
      // Typed-field codegen: if the parameter's type is a (specialized) class,
      // record its class id so the callee uses the typed struct layout for it.
      try {
        const pcid = this.classOfExpr(p.name);
        if (pcid !== undefined) (ctx.paramClasses ||= {})[String(lid)] = pcid;
      } catch { /* ignore */ }
    }
    // 3. prologue: the scope record for the record-resident bindings this
    // function owns (one allocation; fields start as undefined), then a cell
    // for every other captured binding it owns (declared here & captured).
    const decl = this.declaredIn(node);
    const ownRecord = this.captureContexts ? this.recordOfOwner.get(node as ts.Node) : undefined;
    if (ownRecord) {
      const site = this.site++;
      const rl = this.newLocal(ctx, "reference", `ctx_${name}`, ownRecord.binding);
      this.labels[site] = `ctx@${name}`;
      // the synthetic __module_init node has no source position
      this.recordSite(site, "cell", "once", true, (node as ts.Node).pos >= 0 ? (node as ts.Node) : undefined, true);
      ctx.body.push({ kind: "AllocObject", dst: rl, typeId: 0, site, classId: ownRecord.classId });
      (ctx.recordLocals ??= new Map()).set(node as ts.Node, rl);
      for (const s of ownRecord.syms) (ctx.recordAccess ??= new Map()).set(s, { obj: rl, field: ownRecord.fields.get(s)! });
      if (node === (this.moduleInitNode as unknown as FnLike) && this.moduleCtxGlobal !== undefined) {
        ctx.body.push({ kind: "StoreGlobal", gref: this.moduleCtxGlobal, src: rl });
      }
    }
    for (const s of decl) {
      if (this.cellBindings.has(s) && !ctx.cellAccess.has(s) && !(ownRecord && ownRecord.fields.has(s))) {
        const site = this.site++;
        const cell = this.newLocal(ctx, "reference", `cell_${(s as any).name ?? "v"}`, this.bindingIdOf(s));
        this.labels[site] = `cell:${(s as any).name ?? "cell"}@${name}`;
        const declNode = (s.valueDeclaration ?? s.declarations?.[0]) as ts.Node | undefined;
        this.recordSite(site, "cell", this.inLoop(declNode) ? "many" : "once", true, declNode, true);
        ctx.body.push({ kind: "AllocObject", dst: cell, typeId: 0, site, classId: this.cellClassId });
        ctx.cellAccess.set(s, cell);
        // Step E: if this module-scope binding is captured by a method, publish
        // the cell object into its GLOBALS[] slot so methods (which can't receive
        // cell params) can read it.
        const gid = this.moduleCellGlobal.get(s);
        if (gid !== undefined) {
          ctx.body.push({ kind: "StoreGlobal", gref: gid, src: cell });
        }
      }
    }
    // Initialize parameters in source order after their captured bindings have
    // cells. Later defaults can then read earlier destructured/captured params.
    for (const binding of parameterBindings) {
      const p = binding.node;
      if (p.initializer) {
        const isUndef = this.newLocal(ctx, "primitive");
        ctx.body.push({ kind: "UnOp", dst: isUndef, op: "isundef", operand: binding.local });
        const thenBody = this.captureBody(ctx, () => {
          const v = this.lowerExpr(ctx, p.initializer!);
          ctx.body.push({ kind: "Copy", dst: binding.local, src: v });
        });
        ctx.body.push({ kind: "If", cond: isUndef, thenBody, elseBody: [] });
      }
      if (!ts.isIdentifier(p.name)) {
        this.lowerBindingPattern(ctx, p.name, binding.local);
      } else {
        const psym = this.symbolOf(p.name);
        if (psym && this.hasCaptured(ctx, psym)) this.storeCaptured(ctx, psym, binding.local);
      }
    }
    // 3b. parameter properties: `constructor(public x)` implies `this.x = x`
    if (ts.isConstructorDeclaration(node as ts.Node) && ctx.thisLocal !== undefined) {
      for (const p of node.parameters) {
        if (!ts.isIdentifier(p.name)) continue;
        const isParamProp = p.modifiers?.some((mod) =>
          mod.kind === ts.SyntaxKind.PublicKeyword || mod.kind === ts.SyntaxKind.PrivateKeyword ||
          mod.kind === ts.SyntaxKind.ProtectedKeyword || mod.kind === ts.SyntaxKind.ReadonlyKeyword);
        if (isParamProp) {
          const psym = this.symbolOf(p.name);
          const src = psym ? this.ensureLocal(ctx, psym, this.refKindOf(p.name), p.name.text)
                           : this.newLocal(ctx, this.refKindOf(p.name), p.name.text);
          ctx.body.push({ kind: "StoreField", obj: ctx.thisLocal, field: this.internField(p.name.text), src });
        }
      }
      // 3c. field initializers (§3.5): `class C { a = <expr> }` run at the top of
      // the constructor (this runs the OWN class's inits; the parent's inits run
      // when super() invokes the parent ctor). thisLocal is already bound here.
      if (ctx.currentClass !== undefined) {
        this.emitFieldInitializers(ctx, ctx.currentClass, ctx.thisLocal);
      }
    }
    // 3d. HOISTING (Step D, scope_resolution.md §6). JS hoists `var` and
    // `function` declarations to the top of the enclosing function:
    //   - `function f(){}` is fully hoisted (callable before its textual site).
    //   - `var x` is hoisted as an `undefined`-initialized binding (readable
    //     before its assignment; `typeof x` is "undefined", not a ReferenceError).
    // `let`/`const`/`class` are NOT hoisted (TDZ); we rely on the TS checker to
    // reject early reads (§6.3). We scan the body (not descending into nested
    // functions or class bodies) for these declarations and emit their bindings
    // here at the prologue, before the textual body runs.
    if (node.body && ts.isBlock(node.body)) {
      this.hoistDeclarations(ctx, node.body);
    }
    // 4. body
    if (node.body) {
      // v1 async: only top-level awaits are supported (the state machine splits
      // The general state-machine builder handles await/yield inside loops,
      // conditionals, and sub-expressions (short-circuit && / || / ?: lower the
      // rhs into an If, preserving evaluation order). A single
      // try { ...suspend... } catch is supported via the coroutine EH builder;
      // the remaining try shapes are rejected loudly.
      if (isAsync || isGenerator) {
        const why = this.unsupportedSuspendInTry(node.body);
        if (why) this.unsupported(node, `${why} (coroutine exception handling limitation)`);
      }
      // yield* (generator delegation) is now supported via lowering to an explicit
      // driving loop in lowerExpr; no rejection here.
      if (ts.isBlock(node.body)) {
        this.lowerStmt(ctx, node.body);
        // A reachable end of the body is an implicit `return undefined`. Make
        // it explicit so the analyzer sees the undefined result: a function
        // whose explicit returns are all numeric but whose end is reachable
        // must not get a numeric direct-call clone (it would read the
        // fall-through as 0).
        if (this.statementsCompleteNormally(node.body.statements)) ctx.body.push({ kind: "Return" });
      } else ctx.body.push({ kind: "Return", src: this.lowerExpr(ctx, node.body) });
    }

    // JS Function.prototype.length: leading params with no default, before the
    // first defaulted/rest/optional param (a leading explicit `this` is excluded).
    // NB: TS optional `?` is erased at runtime, so an optional param still counts
    // toward .length (V8 sees the type-stripped function); only a default value or
    // a rest param stops the count.
    const arity = this.jsFunctionArity(node.parameters);
    // `fn.name`: a named function/method keeps its name (ctx.name). An anonymous
    // arrow / function expression takes the JS-inferred name from its binding
    // context (`const f = () => {}` -> "f", `{ m: () => {} }` -> "m"), else "".
    let displayName = ctx.name;
    if (ts.isArrowFunction(node) || (ts.isFunctionExpression(node) && !node.name)) {
      const par = (node as ts.Node).parent;
      if (par && ts.isVariableDeclaration(par) && ts.isIdentifier(par.name)) displayName = par.name.text;
      else if (par && ts.isPropertyAssignment(par) && ts.isIdentifier(par.name)) displayName = par.name.text;
      else if (par && ts.isBinaryExpression(par) && par.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(par.left)) displayName = par.left.text;
      else displayName = "";
    } else if (ts.isMethodDeclaration(node as ts.Node) || ts.isGetAccessorDeclaration(node as ts.Node) ||
               ts.isSetAccessorDeclaration(node as ts.Node)) {
      // A class or object-literal member is named after its key, an accessor "get x" / "set x"
      // (V8); a computed key other than a well-known symbol has no static name here. (The
      // member's C symbol is the debugName below; this is what `fn.name` reads.)
      const m = node as unknown as ts.MethodDeclaration | ts.AccessorDeclaration;
      const key = this.memberKeyName(m.name);
      displayName = key === undefined ? "" : ts.isGetAccessorDeclaration(m) ? `get ${key}` :
        ts.isSetAccessorDeclaration(m) ? `set ${key}` : key;
    }
    this.functions.push({
      id: ctx.id,
      name: displayName,
      params: ctx.params,
      ret: 0,
      locals: ctx.locals,
      body: ctx.body,
      isExported: ctx.isExported,
      paramClasses: ctx.paramClasses || {},
      restParam: ctx.restParam ?? null,
      isAsync: ctx.isAsync ?? false,
      isGenerator: ctx.isGenerator ?? false,
      takesThis: thisParam || staticThis,
      captureCount: ctx.captureCount ?? 0,
      arity,
      hasPrototype: !name.startsWith("__") &&
        (ts.isFunctionDeclaration(node as ts.Node) || ts.isFunctionExpression(node as ts.Node)) &&
        !isAsync && !isGenerator,
      debugName: this.debugNameOf(node as ts.Node),
      src: this.srcOf(node as ts.Node),
    });
    if (isExported) this.exports.push(ctx.id);
  }

  // ---- reachability of a function body's end ----
  // Can execution fall off the end of this statement list? Conservative in the
  // direction of "yes" (an unsure answer only costs a numeric clone).
  statementsCompleteNormally(stmts: readonly ts.Statement[]): boolean {
    for (const s of stmts) if (!this.statementCompletesNormally(s)) return false;
    return true;
  }
  statementCompletesNormally(s: ts.Statement): boolean {
    if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return false;
    // A break or continue transfers control: nothing after it in its sequence
    // runs, so a clause body `{ ...; continue; }` does not fall through (the
    // braces used to hide the transfer and sent the switch to the slow form).
    if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) return false;
    if (ts.isBlock(s)) return this.statementsCompleteNormally(s.statements);
    if (ts.isIfStatement(s)) {
      return this.statementCompletesNormally(s.thenStatement) ||
        (s.elseStatement ? this.statementCompletesNormally(s.elseStatement) : true);
    }
    if (ts.isSwitchStatement(s)) {
      const clauses = s.caseBlock.clauses;
      if (!clauses.some(ts.isDefaultClause)) return true;
      // A `break` leaving the switch continues after it; otherwise every clause
      // falls through to the next and the last clause decides.
      if (clauses.some((c) => this.hasBreakLeaving(c.statements))) return true;
      return this.statementsCompleteNormally(clauses[clauses.length - 1].statements);
    }
    if (ts.isWhileStatement(s) || ts.isForStatement(s) || ts.isDoStatement(s)) {
      const cond = ts.isForStatement(s) ? s.condition : s.expression;
      const unconditional = cond === undefined || cond.kind === ts.SyntaxKind.TrueKeyword;
      if (!unconditional) return true;
      // `while (true)` / `for (;;)` is only left through a break.
      return this.hasBreakLeaving([s.statement]);
    }
    if (ts.isTryStatement(s)) {
      if (s.finallyBlock && !this.statementsCompleteNormally(s.finallyBlock.statements)) return false;
      const tryNormal = this.statementsCompleteNormally(s.tryBlock.statements);
      const catchNormal = s.catchClause ? this.statementsCompleteNormally(s.catchClause.block.statements) : false;
      return tryNormal || catchNormal;
    }
    return true; // labeled statements, expression statements, declarations, loops with conditions, ...
  }
  // Does a switch clause body run into the next clause? Empty bodies group
  // labels; a body whose last statement is break/continue/return/throw, or
  // that cannot complete normally, does not fall through.
  clauseFallsThrough(stmts: readonly ts.Statement[]): boolean {
    if (stmts.length === 0) return true;
    const last = stmts[stmts.length - 1];
    if (ts.isBreakStatement(last) || ts.isContinueStatement(last) || ts.isReturnStatement(last) || ts.isThrowStatement(last)) return false;
    return this.statementsCompleteNormally(stmts);
  }
  // Is there a `break` in these statements that leaves the enclosing switch or
  // loop they belong to? A break nested in an inner loop or switch targets that
  // inner statement; a labeled break is counted conservatively. Nested
  // functions and classes are not entered.
  hasBreakLeaving(stmts: readonly ts.Statement[]): boolean {
    let found = false;
    const visit = (n: ts.Node, nested: boolean): void => {
      if (found) return;
      if (ts.isBreakStatement(n)) { if (n.label || !nested) found = true; return; }
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      const inner = nested || ts.isIterationStatement(n, false) || ts.isSwitchStatement(n);
      ts.forEachChild(n, (c) => visit(c, inner));
    };
    for (const s of stmts) visit(s, false);
    return found;
  }

  // ---- class helpers ----
  jsFunctionArity(params: readonly ts.ParameterDeclaration[] | undefined): number {
    let arity = 0;
    for (const p of params ?? []) {
      if (ts.isIdentifier(p.name) && p.name.text === "this") continue;
      if (p.initializer || p.dotDotDotToken) break;
      arity++;
    }
    return arity;
  }
  /** static class id of an expression's type, if it is a known class. */
  classOfExpr(e: ts.Expression): number | undefined {
    try {
      const t = this.checker.getTypeAtLocation(e);
      const sym = t.getSymbol();
      if (!sym) return undefined;
      // `typeof C` (the static side / constructor type — e.g. `this` inside a
      // static method, whose statics live on a plain container object) shares the
      // class symbol with the instance type C, but it is NOT an instance: it has
      // construct signatures. Classifying it as the class would wrongly devirtualize
      // `this.staticMethod()` to a non-existent instance vtable slot. Treat it as
      // unknown so member access goes through the generic ts_get/dynamic path.
      if (t.getConstructSignatures && t.getConstructSignatures().length > 0) return undefined;
      let id = this.classSymToId.get(sym);
      if (id === undefined) {
        // the type's symbol instance can differ from the declaration symbol used
        // to build the map; fall back to matching the class declaration node.
        const decls = sym.getDeclarations?.() ?? [];
        for (const d of decls) {
          if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) {
            for (const [cid, node] of this.classNodeOfId) {
              if (node === d) { id = cid; break; }
            }
          }
          if (id !== undefined) break;
        }
      }
      if (id === undefined) {
        // Name collision with an ambient global type (e.g. a user `class Node`
        // shadowed by lib.dom's `Node`): getTypeAtLocation resolves to the DOM
        // interface symbol, which has no user class declaration. If EVERY
        // declaration of this symbol is ambient (.d.ts) and a user class of the
        // same name exists, the user class shadows the global — use it.
        const decls = sym.getDeclarations?.() ?? [];
        const allAmbient = decls.length > 0 && decls.every((d) => d.getSourceFile().fileName.endsWith(".d.ts"));
        if (allAmbient) {
          const nm = sym.getName();
          for (const [cid, node] of this.classNodeOfId) {
            if (node.name && node.name.text === nm) { id = cid; break; }
          }
        }
      }
      if (id === undefined) return undefined;
      // If this is a generic instance (Box<number>), resolve to its specialized
      // class so method dispatch hits the cloned, concretely-typed method. This
      // is intentionally provenance-gated: a static type like Box<number> can be
      // produced through `as any`, while the object was allocated as erased Box.
      const spec = this.classInstanceSpecializationSourceSafe(e)
        ? this.specializedClassId(t, e)
        : undefined;
      return spec !== undefined ? spec : id;
    } catch {
      return undefined;
    }
  }
  /** Returns the internal slot name for a well-known computed method name
   *  ([Symbol.iterator] -> "@@iterator", [Symbol.asyncIterator] -> "@@asyncIterator"),
   *  or undefined for ordinary methods. */
  wellKnownMethodName(m: ts.ClassElement): string | undefined {
    if (!ts.isMethodDeclaration(m)) return undefined;
    const nameNode = m.name;
    if (!nameNode || !ts.isComputedPropertyName(nameNode)) return undefined;
    const txt = nameNode.expression.getText();
    if (/Symbol\s*\.\s*iterator$/.test(txt)) return "@@iterator";
    if (/Symbol\s*\.\s*asyncIterator$/.test(txt)) return "@@asyncIterator";
    return undefined;
  }

  classHasMethod(classId: number, name: string): boolean {
    return this.findMember(classId, name, "method") !== undefined;
  }
  /** Resolve a static method's fnId AND its declaring class (own or inherited),
   *  walking the class chain. The declaring fnId is Direct-called/boxed; the body
   *  takes `this` (the receiver container) as arg0, so subclass-awareness comes from
   *  the runtime proto chain rather than per-receiver specialization. */
  resolveStaticMethod(classId: number, name: string): { fnId: number; declClass: number } | undefined {
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const fn = this.staticMethodFunc.get(`${cur}:static:${name}`);
      if (fn !== undefined) return { fnId: fn, declClass: cur };
      cur = this.parentIdOf(cur);
    }
    return undefined;
  }
  /** Resolve a static getter's fnId (own or inherited), walking the class chain.
   *  Used for `super.x` where x is a static getter (invoked with this=receiver). */
  staticGetterFnOf(classId: number, name: string): number | undefined {
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const fn = this.staticGetterFunc.get(`${cur}:static:${name}`);
      if (fn !== undefined) return fn;
      cur = this.parentIdOf(cur);
    }
    return undefined;
  }
  /** Emit `throw new TypeError(msg)`: a tagged object with `.message`/`.name`
   *  (mirrors the new-Error lowering) followed by Throw. Used where JS rejects an
   *  assignment with a TypeError (e.g. `super.x = v` into a getter-only member). */
  emitThrowTypeError(ctx: FnCtx, node: ts.Node, msg: string) {
    const err = this.newLocal(ctx, "reference");
    const site = this.site++;
    this.recordSite(site, "object", "once", true, node);
    ctx.body.push({ kind: "AllocObject", dst: err, typeId: 0, site });
    const m = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: m, value: { kind: "Str", value: msg } });
    ctx.body.push({ kind: "StoreField", obj: err, field: this.internField("message"), src: m });
    const nm = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: nm, value: { kind: "Str", value: "TypeError" } });
    ctx.body.push({ kind: "StoreField", obj: err, field: this.internField("name"), src: nm });
    ctx.body.push({ kind: "Throw", src: err });
  }

  /** The static SETTER fnId for `name` resolved up the class chain from `classId`
   *  (mirror of staticGetterFnOf). Used for `super.x = v` in a static method. */
  staticSetterFnOf(classId: number, name: string): number | undefined {
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const fn = this.staticSetterFunc.get(`${cur}:static:${name}`);
      if (fn !== undefined) return fn;
      cur = this.parentIdOf(cur);
    }
    return undefined;
  }
  /** Does the class (or any ancestor) declare an INSTANCE FIELD named `name`?
   *  An own instance field shadows a prototype method of the same name (JS
   *  own->prototype order), so a same-named method call must NOT be statically
   *  devirtualized to the prototype method — it has to go through the dynamic
   *  own->prototype lookup. */
  classHasField(classId: number, name: string): boolean {
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const ci = this.classInfos[cur];
      if (ci.ownFields.includes(name)) return true;
      cur = this.parentIdOf(cur);
    }
    return false;
  }
  /** Is the class's `name` method (e.g. "@@iterator") a generator (`*method()`)?
   *  If so, calling it returns one of OUR generator objects, whose .next() is the
   *  generator.next builtin — not a prototype method dispatch. */
  classMethodIsGenerator(classId: number, name: string): boolean {
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const ci = this.classInfos[cur];
      const m = ci.ownMethods.find((mm) => mm.name === name && mm.kind === "method");
      if (m) return !!m.isGenerator;
      cur = this.parentIdOf(cur);
    }
    return false;
  }
  private parentIdOf(classId: number): number | undefined {
    // Symbol-resolved parent (scope-correct): `extends X` was resolved to the class id
    // via X's lexically-resolved symbol in class_extract (or set by specialization).
    // undefined when the parent isn't a user class (a builtin / unresolved binding).
    return this.classInfos[classId]?.parentId;
  }
  /** The nearest class (self or ancestor) that owns a static container, for
   *  resolving static field accesses including inherited statics. */
  private staticContainerClassOf(classId: number | undefined): number | undefined {
    let cur = classId;
    while (cur !== undefined) {
      if (this.classStaticGlobal.has(cur)) return cur;
      cur = this.parentIdOf(cur);
    }
    return undefined;
  }
  /** For a static field access `C.field`, find the container class to read from:
   *  the nearest class in C's chain that DECLARES `field` as a static (so an
   *  overriding subclass shadows the parent). Falls back to the nearest class
   *  with any static container. */
  private staticFieldClassOf(classId: number | undefined, field: string): number | undefined {
    let cur = classId;
    while (cur !== undefined) {
      if (this.classStaticGlobal.has(cur) && this.classStaticFieldNames.get(cur)?.has(field)) return cur;
      cur = this.parentIdOf(cur);
    }
    return this.staticContainerClassOf(classId);
  }
  /** True if `classId` extends the builtin `Error` (or one of its standard
   *  subclasses) rather than a user class. Used so `super(msg)` sets the
   *  observable `this.message`. The parent name isn't a user class id. */
  /** Index of a built-in Error-family constructor name (matching the runtime
   *  ts_error_proto / ts_new_error kind order), or undefined if not one. */
  errorKindIndex(name: string): number | undefined {
    const i = ["Error", "TypeError", "RangeError", "SyntaxError",
               "ReferenceError", "EvalError", "URIError", "AggregateError"].indexOf(name);
    return i < 0 ? undefined : i;
  }
  private extendsBuiltinError(classId: number): boolean {
    const ci = this.classInfos[classId];
    const p = ci?.parentName;
    if (p === undefined) return false;
    // The parent must NOT resolve to a user class (those go via parentIdOf). Decide by
    // SYMBOL, not name: `parentId === undefined` means `extends X` resolved to a
    // non-user-class binding — i.e. lexical resolution found no user class shadowing X
    // in scope, so X is the global builtin. A user `class Error {}` in an inner scope
    // sets parentId (it's a user class) and is correctly NOT treated as builtin.
    if (ci.parentId !== undefined) return false;
    return p === "Error" || p === "TypeError" || p === "RangeError" ||
           p === "SyntaxError" || p === "ReferenceError" || p === "EvalError" ||
           p === "URIError" || p === "AggregateError";
  }
  /** Walk c upward; return {classId, kind} of the most-derived member `name` of
   *  the requested kind ("method"|"getter"|"setter"), or undefined. */
  findMember(classId: number, name: string, kind: "method" | "getter" | "setter"): { classId: number } | undefined {
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const ci = this.classInfos[cur];
      if (ci.ownMethods.some((m) => m.name === name && m.kind === kind)) return { classId: cur };
      cur = this.parentIdOf(cur);
    }
    return undefined;
  }
  /** `super.m` resolves statically only along stable classes: a dynamic class
   *  between the parent and the one declaring `m` (inclusive) may have had its
   *  prototype written or relinked, so the lookup is a runtime one. */
  superPathIsDynamic(parentId: number, name: string): boolean {
    const found = this.findMember(parentId, name, "method");
    let cur: number | undefined = parentId;
    while (cur !== undefined) {
      if (!this.classInfos[cur]?.stable) return true;
      if (found !== undefined && cur === found.classId) return false;
      cur = this.parentIdOf(cur);
    }
    return found === undefined;
  }
  /** The method value of `super.m` read as JS reads it: from the home object's
   *  current prototype, the written property (the field key, which a
   *  `C.prototype.m = f` stores) first, then the class-body method (the method
   *  key). undefined when the class value cannot be loaded here (the static
   *  resolution stands). */
  lowerDynamicSuperMethod(ctx: FnCtx, name: string): number | undefined {
    const cid = ctx.currentClass;
    if (cid === undefined) return undefined;
    const csym = this.classSymbolOfId(cid);
    if (!csym) return undefined;
    const classValue = this.loadBoundClassValue(ctx, csym, this.classInfos[cid]?.name);
    if (classValue === undefined) return undefined;
    const home = this.loadClassValuePrototype(ctx, classValue);
    const proto = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "GetProto", dst: proto, obj: home });
    const own = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "LoadField", dst: own, obj: proto, field: this.internField(name) });
    const ty = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "UnOp", dst: ty, op: "typeof", operand: own });
    const fnStr = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: fnStr, value: { kind: "Str", value: "function" } });
    const isFn = this.newLocal(ctx, "primitive");
    ctx.body.push({ kind: "BinOp", dst: isFn, op: "===", lhs: ty, rhs: fnStr });
    const mv = this.newLocal(ctx, "reference");
    ctx.body.push({
      kind: "If", cond: isFn,
      thenBody: [{ kind: "Copy", dst: mv, src: own }],
      elseBody: [{ kind: "LoadMethodValue", dst: mv, recv: proto, method: this.internName(name) }],
    });
    return mv;
  }
  /** FunctionId of a resolved member, searching from classId upward. */
  resolveMemberFunc(classId: number, name: string, kind: "method" | "getter" | "setter"): number | undefined {
    const found = this.findMember(classId, name, kind);
    if (!found) return undefined;
    return this.methodFunc.get(`${found.classId}:${kind}:${name}`);
  }
  /** Is `name` a getter (anywhere up the chain) on classId? */
  hasGetter(classId: number, name: string): boolean { return this.findMember(classId, name, "getter") !== undefined; }
  hasSetter(classId: number, name: string): boolean { return this.findMember(classId, name, "setter") !== undefined; }

  /** Pre-pass: extract classes, assign a FunctionId to every method body, and
   *  record them for lifting. Must run before free-variable analysis so method
   *  bodies participate in capture analysis like any other function. */
  setupClasses(_sf: ts.SourceFile) {
    this.classExtractor = new ClassExtractor(this.program);
    // Bundler: extract classes from EVERY module at once so cross-module
    // `extends` resolves and class ids are unique across files.
    const { classes, symbolToId, nodeToId, closedReceivers } = this.classExtractor.extractAll(this.modules);
    this.classInfos = classes;
    this.closedReceivers = closedReceivers;
    // Typed cells: every captured-variable cell is an instance of one synthetic
    // class with a single struct field, so reads and writes of captured
    // variables compile to a direct field access instead of a cached property
    // lookup. TSAOT_TYPED_CELLS=0 keeps the plain-object cells (legacy IR).
    if (process.env.TSAOT_TYPED_CELLS !== "0") {
      this.cellClassId = this.classInfos.length;
      this.classInfos.push({
        id: this.cellClassId, name: "__cell", ownMethods: [], ownFields: ["__value"],
        instantiated: true, stable: true, reasons: [],
      });
    }
    this.classSymToId = symbolToId;
    this.classIdByNode = nodeToId;

    // assign FunctionIds to method/getter/setter/constructor declarations
    const visit = (n: ts.Node) => {
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
        // Key by the class NODE (covers anonymous class expressions with no name
        // symbol). Falls back to the name symbol for robustness.
        let classId = this.classIdByNode.get(n);
        if (classId === undefined && n.name) {
          const csym = this.symbolOf(n.name);
          classId = csym ? this.classSymToId.get(csym) : undefined;
        }
        if (classId !== undefined) {
          this.classNodeOfId.set(classId, n);
          if (this.classInfos[classId]?.reasons.includes("cyclic-extends")) {
            this.unsupported(n, "cyclic class extends hierarchy (self/mutual extends would throw at runtime)");
          }
          // A base that is not a class declaration (a mixin call, a class-valued
          // constant) was neither laid out nor linked: the instance lacked the
          // base's fields and methods (silent wrong values). Reject it loudly.
          const reasons = this.classInfos[classId]?.reasons ?? [];
          const ext = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
          if (ext && (reasons.includes("extends-non-identifier(mixin)") || reasons.includes("extends-value(unresolved)"))) {
            this.unsupported(ext, "class extends an expression or a class-valued binding (only a class declaration or a library class is supported as a base)");
          }
          // A built-in base other than the Error classes (a typed array, Map, Array, Promise):
          // the instance would be a plain object, not one of the base's kind (silent wrong values).
          if (ext && ts.isIdentifier(ext) && this.classInfos[classId]?.parentId === undefined && !this.extendsBuiltinError(classId)) {
            const bsym = this.symbolOf(ext);
            if (bsym && this.isAmbientGlobalSymbol(bsym)) {
              this.unsupported(ext, `class extends the built-in ${ext.text} (only the Error classes are supported as a built-in base; an instance would be a plain object, not a ${ext.text})`);
            }
          }
          let hasStatic = false;
          for (const m of n.members) {
            const isStatic = this.isStaticMember(m);
            const wkName = this.wellKnownMethodName(m);
            // A static dynamic/symbol-keyed member (`static [Symbol.x]`,
            // `static [mySym]`, `static [k]`). `[Symbol.iterator]/[asyncIterator]`
            // methods are NOT dynamic (well-known -> handled below). We install
            // these on the static container in lowerStaticInit; reads resolve via
            // the class identifier -> container (§71) + symbol.get / dynamic read.
            // `static [Symbol.hasInstance]` installs like any symbol method (under
            // the wksym key) and is consulted by the `instanceof` lowering (which
            // detects the hook via classHasHasInstanceHook). Generator/async methods
            // install too: lowerFunctionLike lowers the body as a state machine and
            // lowerStaticInit boxes it as a ts_func value (a coroutine entry point is
            // a plain function returning a generator/promise, callable like any other).
            if (isStatic && this.isDynComputedMember(m)) {
              if ((ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.body) {
                // Method/getter/setter: lift as a plain-this static member (this =
                // container) and install on the container in lowerStaticInit, which
                // reads the fnId back by node identity (this.fnId.get(m)).
                hasStatic = true;
                const fnId = this.fnId.size;
                this.fnId.set(m, fnId);
                this.methodDecls.push({ node: m, fnId, classId, thisName: "" });
                continue;
              }
              if (ts.isPropertyDeclaration(m)) {
                // Field: no fnId; lowerStaticInit lowers the initializer + installs it.
                hasStatic = true;
                continue;
              }
              this.unsupported(m, "static class member with a dynamic or symbol computed name (unsupported shape)");
              continue;
            }
            // Step F: a static METHOD is a plain function (no `this` instance,
            // not in the vtable). Record it under staticMethodFunc and lift it
            // like a free function (thisParam=false).
            if (isStatic && ts.isMethodDeclaration(m) && m.body && memberKeyName(m.name) !== undefined) {
              hasStatic = true;
              const sname = memberKeyName(m.name)!;
              const fnId = this.fnId.size;
              this.fnId.set(m, fnId);
              this.staticMethodFunc.set(`${classId}:static:${sname}`, fnId);
              // lifted as a free function (no this); reuse methodDecls with a
              // sentinel by lowering separately — store in staticInits' sibling
              // list via methodDecls with classId but thisName "" to signal static.
              this.methodDecls.push({ node: m, fnId, classId, thisName: "" });
              continue;
            }
            // Step F: a static ACCESSOR (`static get v()` / `static set v(x)`) is
            // a plain function (no instance `this`; `this` is bound to the class's
            // static container in lowerFunctionLike). Record it in the static
            // getter/setter maps and lift it like a free function (thisParam=false).
            // Must be caught HERE (before the generic accessor branch below), else
            // it would be wrongly registered as an INSTANCE accessor on the proto.
            if (isStatic && ts.isGetAccessorDeclaration(m) && m.body && memberKeyName(m.name) !== undefined) {
              hasStatic = true;
              const sname = memberKeyName(m.name)!;
              const fnId = this.fnId.size;
              this.fnId.set(m, fnId);
              this.staticGetterFunc.set(`${classId}:static:${sname}`, fnId);
              this.methodDecls.push({ node: m, fnId, classId, thisName: "" });
              continue;
            }
            if (isStatic && ts.isSetAccessorDeclaration(m) && m.body && memberKeyName(m.name) !== undefined) {
              hasStatic = true;
              const sname = memberKeyName(m.name)!;
              const fnId = this.fnId.size;
              this.fnId.set(m, fnId);
              this.staticSetterFunc.set(`${classId}:static:${sname}`, fnId);
              this.methodDecls.push({ node: m, fnId, classId, thisName: "" });
              continue;
            }
            // Static well-known-symbol METHOD (`static [Symbol.iterator]() {}`):
            // lower it as a plain-this static member and install it on the static
            // container under the symbol key (in __static_init). Catch it HERE —
            // `isDynComputedMember` excludes well-known symbols, so it isn't
            // loud-rejected above, and `memberKeyName` is undefined for a computed
            // name, so it would otherwise fall through to the generic branch below
            // and be wrongly registered as an INSTANCE @@iterator vtable method.
            if (isStatic && wkName !== undefined && ts.isMethodDeclaration(m) && m.body) {
              hasStatic = true;
              const fnId = this.fnId.size;
              this.fnId.set(m, fnId); // lowerStaticInit installs it via this.fnId.get(m)
              this.methodDecls.push({ node: m, fnId, classId, thisName: "" });
              continue;
            }
            // Static fields and static blocks: mark the class as having statics
            // (their initialization is synthesized in __static_init below).
            if (isStatic && (ts.isPropertyDeclaration(m))) {
              hasStatic = true;
              const sfn = memberKeyName(m.name);
              if (sfn !== undefined && sfn !== "name" && sfn !== "length") {
                let set = this.classStaticFieldNames.get(classId);
                if (!set) { set = new Set(); this.classStaticFieldNames.set(classId, set); }
                set.add(sfn);
              }
              continue;
            }
            if (ts.isClassStaticBlockDeclaration(m)) { hasStatic = true; continue; }
            const mname = wkName ?? memberKeyName(m.name);
            if (ts.isMethodDeclaration(m) && m.body && mname !== undefined) {
              const fnId = this.fnId.size;
              this.fnId.set(m, fnId);
              this.methodFunc.set(`${classId}:method:${mname}`, fnId);
              this.methodDecls.push({ node: m, fnId, classId, thisName: "this" });
            } else if (ts.isGetAccessorDeclaration(m) && m.body && mname !== undefined) {
              const fnId = this.fnId.size;
              this.fnId.set(m, fnId);
              this.methodFunc.set(`${classId}:getter:${mname}`, fnId);
              this.methodDecls.push({ node: m, fnId, classId, thisName: "this" });
            } else if (ts.isSetAccessorDeclaration(m) && m.body && mname !== undefined) {
              const fnId = this.fnId.size;
              this.fnId.set(m, fnId);
              this.methodFunc.set(`${classId}:setter:${mname}`, fnId);
              this.methodDecls.push({ node: m, fnId, classId, thisName: "this" });
            } else if (ts.isConstructorDeclaration(m) && m.body) {
              const fnId = this.fnId.size;
              this.fnId.set(m, fnId);
              this.methodFunc.set(`${classId}:ctor`, fnId);
              this.methodDecls.push({ node: m, fnId, classId, thisName: "this" });
            }
          }
          // class + namespace merge (`class X {} namespace X { export ... }`): the
          // class symbol's other declarations include value namespace(s). Force a
          // static container so the namespace's exported members install on it and
          // `X.member` resolves (the members are lowered in lowerModuleDeclaration,
          // which targets the container for a merged class).
          {
            const cmsym = n.name ? this.symbolOf(n.name) : undefined;
            const hasMergedNs = (cmsym?.declarations ?? []).some(
              (dd) => ts.isModuleDeclaration(dd) && ts.isIdentifier(dd.name) && this.isValueNamespace(dd));
            if (hasMergedNs) hasStatic = true;
          }
          // Step F: a class that has OR inherits statics gets its own static
          // container global + __static_init. Inheriting subclasses need one too
          // (even with no own statics) so a static method invoked on the subclass
          // binds `this` to the subclass's own (proto-linked) container — writes
          // then create shadowing own props on it, matching JS. Parents are visited
          // before children (base must be declared first), so the parent's container
          // is already registered here.
          const pid = this.parentIdOf(classId);
          const inheritsStatic = pid !== undefined && this.classStaticGlobal.has(pid);
          if (hasStatic || inheritsStatic) {
            const gid = this.internGlobal(`__static_${classId}`);
            this.classStaticGlobal.set(classId, gid);
            const initId = this.fnId.size;
            // synthetic node key: reuse the class node tagged via staticInits
            this.staticInits.push({ classId, fnId: initId, node: n });
            this.fnId.set({ __staticInitFor: classId } as any, initId);
          }
        }
      }
      n.forEachChild(visit);
    };
    for (const m of this.modules) visit(m);
  }

  /** The static initializer takes the class value as its `this` when one can be made (an explicit or a
   *  synthesized constructor); the declaration and the class expression pass it (staticInitArgs). */
  staticInitTakesThis(classId: number): boolean {
    return this.methodFunc.has(`${classId}:ctor`) || this.synthClassValueCtor(classId) !== undefined;
  }
  /** The static initializer's argument list: the class value (undefined when the site could not make
   *  one: the initializer's `this` reads then throw, loudly), nothing for an initializer without `this`. */
  staticInitArgs(ctx: FnCtx, classId: number, cv: ClassValueEmit | undefined): number[] {
    if (!this.staticInitTakesThis(classId)) return [];
    if (cv !== undefined && cv.classValue) return [cv.local];
    const u = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "Const", dst: u, value: { kind: "Undef" } });
    return [u];
  }
  /** The `this` of a static member reached through the class name (`C.make()`, `C.instance`, `C.v = x`):
   *  the class value, as in JS (`new this()` in a static factory, `this.name`, `this === C` hold inside
   *  the member); the proto-linked container when the class has no constructible value. A member
   *  inherited by a subclass reads and writes the subclass's statics either way (ts_get / ts_set on a
   *  class value go to its container, whose chain mirrors the class chain). */
  staticReceiver(ctx: FnCtx, classRef: ts.Expression, classId: number, containerClass: number): number {
    if (this.staticInitTakesThis(classId)) return this.lowerExpr(ctx, classRef);
    const cont = this.newLocal(ctx, "reference");
    ctx.body.push({ kind: "LoadGlobal", dst: cont, gref: this.classStaticGlobal.get(containerClass)! });
    return cont;
  }
  /** A static accessor of `name` reached from `classId` up the chain, unless a class below the accessor's
   *  declares a static data field of the name (its own property shadows the inherited accessor). */
  staticAccessorBeforeField(classId: number, name: string, which: "get" | "set"): number | undefined {
    const table = which === "get" ? this.staticGetterFunc : this.staticSetterFunc;
    let cur: number | undefined = classId;
    while (cur !== undefined) {
      const fn = table.get(`${cur}:static:${name}`);
      if (fn !== undefined) return fn;
      if (this.staticGetterFunc.has(`${cur}:static:${name}`) || this.staticSetterFunc.has(`${cur}:static:${name}`)) return undefined;   // the other half only
      if (this.classStaticFieldNames.get(cur)?.has(name)) return undefined;
      cur = this.parentIdOf(cur);
    }
    return undefined;
  }
  /** Step F: build __static_init_<classId>: alloc the static container, publish
   *  it to the class's global slot, then run static field inits + static blocks
   *  in source order. */
  lowerStaticInit(classId: number, fnId: number, classNode: ts.ClassLikeDeclaration) {
    const name = `__static_init_${classId}`;
    const ctx: FnCtx = {
      id: fnId, name, params: [], locals: [], body: [],
      localOfSymbol: new Map(), cellAccess: new Map(),
      isExported: false, hoistedFns: new Set(),
    };
    const gid = this.classStaticGlobal.get(classId)!;
    const site = this.site++;
    const container = this.newLocal(ctx, "reference", `static_${classId}`);
    this.labels[site] = `static-container:${classId}`;
    this.recordSite(site, "object", "once", true, classNode, false);
    ctx.body.push({ kind: "AllocObject", dst: container, typeId: 0, site });
    ctx.body.push({ kind: "StoreGlobal", gref: gid, src: container });
    // `this` of the static field initializers and blocks: the class value (JS: the constructor itself,
    // so `new this()`, `this.name` and `this === C` hold), passed by the declaration (staticInitArgs);
    // its [[Prototype]] is linked to the fresh container here, before any initializer reads or writes a
    // static through it. A class without a constructible value keeps the container as `this`.
    const takesThis = this.staticInitTakesThis(classId);
    let thisLocal = container;
    if (takesThis) {
      thisLocal = this.newLocal(ctx, "reference", "this");
      ctx.params.push(thisLocal);
      ctx.body.push({ kind: "SetProto", obj: thisLocal, proto: container });
    }
    const defineStaticData = (obj: number, key: string, val: number, enumerable: 0 | 1, writable: 0 | 1, configurable: 0 | 1) => {
      const keyLocal = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: keyLocal, value: { kind: "Str", value: key } });
      ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
        builtin: `object.defineData:${enumerable}:${writable}:${configurable}`, args: [obj, keyLocal, val] });
    };
    const className = this.classInfos[classId]?.name ?? "";
    const nameLocal = this.newLocal(ctx, "reference", "class.name");
    ctx.body.push({ kind: "Const", dst: nameLocal, value: { kind: "Str", value: className } });
    defineStaticData(container, "name", nameLocal, 0, 0, 1);
    const ctorNode = this.ctorNodeOfClassId(classId);
    const lengthLocal = this.newLocal(ctx, "primitive", "class.length");
    ctx.body.push({ kind: "Const", dst: lengthLocal, value: { kind: "Num", value: this.jsFunctionArity(ctorNode?.parameters) } });
    defineStaticData(container, "length", lengthLocal, 0, 0, 1);
    // `this` inside static field initializers and static blocks: the class value (above). Bound without a
    // currentClass, so `this.x` reads and `this.x = v` writes go through generic ts_get/ts_set, which a
    // class value forwards to its container.
    ctx.thisLocal = thisLocal;
    // Defining class, so `super.X` inside a static block/initializer resolves to the
    // parent's static member.
    ctx.staticClass = classId;
    // Proto-link this container to the nearest ancestor's static container, so the
    // static "class object" chain mirrors the class chain: `this.X`/`C.X` ts_get
    // walks it for inherited statics, and a getter/method found up the chain runs
    // with this=the receiver container (subclass-aware). The parent's __static_init
    // ran earlier (declared first), so its container global is populated.
    const pcc = this.staticContainerClassOf(this.parentIdOf(classId));
    if (pcc !== undefined) {
      const pcont = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadGlobal", dst: pcont, gref: this.classStaticGlobal.get(pcc)! });
      ctx.body.push({ kind: "SetProto", obj: container, proto: pcont });
    }
    // Register OWN static methods and accessors as properties of the container
    // (before field/block init, so static blocks can call them). Methods are boxed
    // ts_funcs (takes_this=1); accessors are real getter/setter descriptors, so
    // `C.v`/`this.v` (plain ts_get/ts_set on the container) auto-invoke them.
    const accessors = new Map<string, { getter?: number; setter?: number }>();
    const accFor = (nm: string) => {
      let a = accessors.get(nm);
      if (a === undefined) { a = {}; accessors.set(nm, a); }
      return a;
    };
    // Dynamic/symbol-keyed static accessors: grouped by the key-expression's source
    // text so a `static get [S.x]()` and `static set [S.x]()` pair into one
    // descriptor (their key source is identical; SameValue pairing within one class
    // body). `symKey` selects symbol.defineAccessor vs the string object.defineAccessor.
    const dynAccessors = new Map<string, { getter?: number; setter?: number; keyExpr: ts.Expression; symKey: boolean }>();
    const dynAccFor = (keyExpr: ts.Expression) => {
      const k = keyExpr.getText();
      let a = dynAccessors.get(k);
      if (a === undefined) { a = { keyExpr, symKey: this.isSymbolKeyExpr(keyExpr) }; dynAccessors.set(k, a); }
      return a;
    };
    for (const m of classNode.members) {
      if (!this.isStaticMember(m)) continue;
      // Static well-known-symbol METHOD (`static [Symbol.iterator]() {}`): install it
      // on the container under the symbol key (ts_set_symkey -> TS_KEY_WKSYM). Then
      // `C[Symbol.x]` (symbol.get) and `for...of C` resolve it via the container's
      // proto chain. The instance @@iterator (if any) lives on CLASS_PROTO under the
      // same key but a different object, so they don't collide.
      if (ts.isMethodDeclaration(m) && m.body && this.wellKnownMethodName(m) !== undefined) {
        const mfn = this.fnId.get(m);
        if (mfn !== undefined) {
          const keyExpr = (m.name as ts.ComputedPropertyName).expression;
          const keyLocal = this.lowerExpr(ctx, keyExpr);
          const fnval = this.newLocal(ctx, "reference");
          const s2 = this.site++;
          this.recordSite(s2, "closure", "once", true, m);
          ctx.body.push({ kind: "AllocClosure", dst: fnval, func: mfn, captures: [], site: s2 });
          const c2 = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadGlobal", dst: c2, gref: gid });
          ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "symbol.set", args: [c2, keyLocal, fnval] });
        }
        continue;
      }
      // Other static dynamic/symbol-keyed members (`static [Symbol.toPrimitive]()`,
      // `static [mySym]()`, `static [k]()`, plus get/set). Methods install as a
      // closure under the (symbol or dynamic-string) key; accessors are grouped and
      // emitted as descriptors below. Fields are handled in the field loop. Reads
      // resolve via the class identifier -> container (§71) + symbol.get / dyn read.
      if (this.isDynComputedMember(m)) {
        const keyExpr = (m.name as ts.ComputedPropertyName).expression;
        const symKey = this.isSymbolKeyExpr(keyExpr);
        if (ts.isMethodDeclaration(m) && m.body) {
          const mfn = this.fnId.get(m);
          if (mfn !== undefined) {
            const keyLocal = this.lowerExpr(ctx, keyExpr);
            const fnval = this.newLocal(ctx, "reference");
            const s2 = this.site++;
            this.recordSite(s2, "closure", "once", true, m);
            ctx.body.push({ kind: "AllocClosure", dst: fnval, func: mfn, captures: [], site: s2 });
            const c2 = this.newLocal(ctx, "reference");
            ctx.body.push({ kind: "LoadGlobal", dst: c2, gref: gid });
            if (symKey) ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "symbol.set", args: [c2, keyLocal, fnval] });
            else ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "object.defineData:0:1:1", args: [c2, keyLocal, fnval] });
          }
        } else if (ts.isGetAccessorDeclaration(m) && m.body) {
          const f = this.fnId.get(m);
          if (f !== undefined) dynAccFor(keyExpr).getter = f;
        } else if (ts.isSetAccessorDeclaration(m) && m.body) {
          const f = this.fnId.get(m);
          if (f !== undefined) dynAccFor(keyExpr).setter = f;
        }
        continue;
      }
      const nm = memberKeyName(m.name);
      if (nm === undefined) continue;
      if (ts.isMethodDeclaration(m) && m.body) {
        const mfn = this.staticMethodFunc.get(`${classId}:static:${nm}`);
        if (mfn === undefined) continue;
        const fnval = this.newLocal(ctx, "reference", nm);
        const fsite = this.site++;
        this.recordSite(fsite, "closure", "once", true, m);
        ctx.body.push({ kind: "AllocClosure", dst: fnval, func: mfn, captures: [], site: fsite });
        const c2 = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadGlobal", dst: c2, gref: gid });
        defineStaticData(c2, nm, fnval, 0, 1, 1);
      } else if (ts.isGetAccessorDeclaration(m) && m.body) {
        const f = this.staticGetterFunc.get(`${classId}:static:${nm}`);
        if (f !== undefined) accFor(nm).getter = f;
      } else if (ts.isSetAccessorDeclaration(m) && m.body) {
        const f = this.staticSetterFunc.get(`${classId}:static:${nm}`);
        if (f !== undefined) accFor(nm).setter = f;
      }
    }
    for (const [nm, gs] of accessors) {
      const c2 = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadGlobal", dst: c2, gref: gid });
      const keyL = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "Const", dst: keyL, value: { kind: "Str", value: nm } });
      const boxFn = (f: number | undefined): number => {
        const v = this.newLocal(ctx, "reference");
        if (f === undefined) { ctx.body.push({ kind: "Const", dst: v, value: { kind: "Undef" } }); return v; }
        const s2 = this.site++; this.recordSite(s2, "closure", "once", true, classNode);
        ctx.body.push({ kind: "AllocClosure", dst: v, func: f, captures: [], site: s2 });
        return v;
      };
      const getterV = boxFn(gs.getter);
      const setterV = boxFn(gs.setter);
      // g_this=1/s_this=1: accessor bodies take `this` (the container) as arg0;
      // non-enumerable, configurable (class accessor semantics).
      ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
        builtin: "object.defineAccessor:1:1:0:1", args: [c2, keyL, getterV, setterV] });
    }
    // Dynamic/symbol-keyed static accessors (same descriptor shape as above, but the
    // key is a lowered symbol/dynamic value -> symbol.defineAccessor / object.defineAccessor).
    for (const gs of dynAccessors.values()) {
      const keyLocal = this.lowerExpr(ctx, gs.keyExpr);
      const c2 = this.newLocal(ctx, "reference");
      ctx.body.push({ kind: "LoadGlobal", dst: c2, gref: gid });
      const boxFn = (f: number | undefined): number => {
        const v = this.newLocal(ctx, "reference");
        if (f === undefined) { ctx.body.push({ kind: "Const", dst: v, value: { kind: "Undef" } }); return v; }
        const s2 = this.site++; this.recordSite(s2, "closure", "once", true, classNode);
        ctx.body.push({ kind: "AllocClosure", dst: v, func: f, captures: [], site: s2 });
        return v;
      };
      const getterV = boxFn(gs.getter);
      const setterV = boxFn(gs.setter);
      const builtin = gs.symKey ? "symbol.defineAccessor:1:1:0:1" : "object.defineAccessor:1:1:0:1";
      ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"),
        builtin, args: [c2, keyLocal, getterV, setterV] });
    }
    for (const m of classNode.members) {
      const isStatic = this.isStaticMember(m);
      const sfname = isStatic && ts.isPropertyDeclaration(m) ? memberKeyName(m.name) : undefined;
      if (isStatic && this.isDynComputedMember(m)) {
        // Static dynamic/symbol-keyed FIELD (`static [Symbol.x]=v` / `static [k]=v`):
        // lower the key + initializer and install on the container (symbol.set for a
        // symbol key, StoreFieldDynamic for a dynamic-string key). Methods/accessors
        // were handled above; a non-field dyn member has no initializer to run here.
        if (ts.isPropertyDeclaration(m)) {
          const keyExpr = (m.name as ts.ComputedPropertyName).expression;
          const keyLocal = this.lowerExpr(ctx, keyExpr);
          let src: number;
          if (m.initializer) src = this.lowerExpr(ctx, m.initializer);
          else { src = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: src, value: { kind: "Undef" } }); }
          const c2 = this.newLocal(ctx, "reference");
          ctx.body.push({ kind: "LoadGlobal", dst: c2, gref: gid });
          if (this.isSymbolKeyExpr(keyExpr)) ctx.body.push({ kind: "CallBuiltinStatic", dst: this.newLocal(ctx, "reference"), builtin: "symbol.set", args: [c2, keyLocal, src] });
          else ctx.body.push({ kind: "StoreFieldDynamic", obj: c2, key: keyLocal, src });
        }
        continue;
      } else if (sfname !== undefined) {
        let src: number;
        if ((m as ts.PropertyDeclaration).initializer) src = this.lowerExpr(ctx, (m as ts.PropertyDeclaration).initializer!, sfname);
        else { src = this.newLocal(ctx, "reference"); ctx.body.push({ kind: "Const", dst: src, value: { kind: "Undef" } }); }
        const c2 = this.newLocal(ctx, "reference");
        ctx.body.push({ kind: "LoadGlobal", dst: c2, gref: gid });
        ctx.body.push({ kind: "StoreField", obj: c2, field: this.internField(sfname), src });
      } else if (ts.isClassStaticBlockDeclaration(m)) {
        m.body.statements.forEach((s) => this.lowerStmt(ctx, s));
      }
    }
    this.noteFnModule(ctx.id);
    this.functions.push({
      id: ctx.id, name: ctx.name, params: ctx.params, ret: 0,
      locals: ctx.locals, body: ctx.body, isExported: false,
      paramClasses: {}, restParam: null, isAsync: false, isGenerator: false, takesThis: takesThis,
    });
  }

  /** Lift a method body into an IR function: param 0 = `this`, then real params
   *  (cells for captured vars are threaded by lowerFunctionLike as usual). */
  lowerMethod(decl: ts.FunctionLikeDeclaration, fnId: number, classId: number) {
    this.lowerFunctionLike(decl as FnLike, fnId, false, /*thisParam*/ true, classId);
  }

  /** Build the classes table for programJson, resolving names/methods to ids. */
  buildClassesTable() {
    this.classesOut = this.classInfos.map((c) => {
      // (an abstract method has no body and no runtime existence: not on the
      // prototype, `"m" in C.prototype` is false; it used to be installed as
      // function 0)
      const methods = c.ownMethods
        .filter((m) => m.kind === "method" || m.kind === "getter" || m.kind === "setter")
        .filter((m) => this.methodFunc.has(`${c.id}:${m.kind}:${m.name}`))
        .map((m) => {
          const callName = m.kind === "getter" ? `get ${m.name}` : m.kind === "setter" ? `set ${m.name}` : m.name;
          const propName = m.name.startsWith("@@") || m.name.startsWith("#") ? undefined : m.name;
          return {
            name: this.internName(callName),
            propName,
            func: this.methodFunc.get(`${c.id}:${m.kind}:${m.name}`)!,
            kind: m.kind,
          };
        });
      // include the constructor so codegen can type `this` inside the ctor body
      const ctorFunc = this.methodFunc.get(`${c.id}:ctor`);
      if (ctorFunc !== undefined) {
        methods.push({ name: this.internName("__ctor__"), propName: undefined, func: ctorFunc, kind: "method" });
      }
      // monomorphization: uniform concrete field types, keyed by interned field id
      const uft = this.uniformFieldTypes(c.id);
      const fieldTypes: Record<string, string> = {};
      for (const [fname, tag] of Object.entries(uft)) {
        fieldTypes[String(this.internField(fname))] = tag;
      }
      // `class X extends Error` (built-in, no user-class parent): record the error
      // kind so codegen chains X.prototype to the shared Error.prototype.
      const errorProtoKind = this.extendsBuiltinError(c.id)
        ? (c.parentName !== undefined ? this.errorKindIndex(c.parentName) : undefined)
        : undefined;
      return {
        id: c.id,
        name: c.name,
        parent: c.parentId ?? null, // symbol-resolved parent id (scope-correct)
        ownMethods: methods,
        ownFields: c.ownFields.map((f) => this.internField(f)),
        instantiated: c.instantiated,
        stable: c.stable,
        reasons: c.reasons,
        fieldTypes,
        errorProtoKind: errorProtoKind ?? null,
      };
    });
  }

  /** Resolve an import/export `moduleSpecifier` string literal to its target
   *  user SourceFile (via the checker's already-resolved module symbol), or
   *  undefined for ambient/lib/declaration modules. */
  private resolveModuleSf(spec: ts.Expression | undefined): ts.SourceFile | undefined {
    if (!spec) return undefined;
    // Resolve the specifier to its target file. getResolvedModuleFromModuleSpecifier
    // works even for side-effect imports (`import "./a"`), where the specifier has
    // no symbol; fall back to the module symbol's SourceFile declaration.
    const anyProg = this.program as unknown as { getResolvedModuleFromModuleSpecifier?: (s: ts.Expression) => { resolvedModule?: { resolvedFileName?: string } } | undefined };
    if (typeof anyProg.getResolvedModuleFromModuleSpecifier === "function") {
      const fn = anyProg.getResolvedModuleFromModuleSpecifier(spec)?.resolvedModule?.resolvedFileName;
      if (fn) {
        const f = this.program.getSourceFile(fn);
        return f && !f.isDeclarationFile ? f : undefined;
      }
    }
    const sym = this.checker.getSymbolAtLocation(spec);
    const decl = sym?.declarations?.find((d) => ts.isSourceFile(d));
    const file = decl as ts.SourceFile | undefined;
    return file && !file.isDeclarationFile ? file : undefined;
  }

  /** The user modules `sf` statically imports / re-exports from (string-literal
   *  specifiers only; ambient/lib excluded). */
  /** The modules `sf` imports. With `runtimeOnly`, a type-only import (erased: it neither
   *  evaluates nor links the module) is left out. The evaluation order is computed over the
   *  runtime edges only: an erased import does not order modules under the emitted program
   *  either (vue's `ast.ts` reached first through type-only imports, with its subtree holding the
   *  parser that reads its enum at the top level, ran after the parser). */
  private moduleDeps(sf: ts.SourceFile, runtimeOnly: boolean = false): ts.SourceFile[] {
    const out: ts.SourceFile[] = [];
    const seen = new Set<ts.SourceFile>();
    for (const stmt of sf.statements) {
      let spec: ts.Expression | undefined;
      if (ts.isImportDeclaration(stmt)) {
        const clause = stmt.importClause;
        if (runtimeOnly && clause !== undefined && (clause.isTypeOnly || (clause.name === undefined && clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)))) continue;
        spec = stmt.moduleSpecifier;
      } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
        if (runtimeOnly && (stmt.isTypeOnly || (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause) && stmt.exportClause.elements.length > 0 &&
            stmt.exportClause.elements.every((e) => e.isTypeOnly)))) continue;
        spec = stmt.moduleSpecifier;
      }
      const target = spec && ts.isStringLiteral(spec) ? this.resolveModuleSf(spec) : undefined;
      if (target && !seen.has(target)) { seen.add(target); out.push(target); }
    }
    // a file with JSX under the automatic runtime imports `<source>/jsx-runtime` (a synthetic import)
    if (this.fileHasJsx(sf)) {
      const rt = this.jsxRuntimeModuleOf(sf);
      if (rt && !seen.has(rt)) { seen.add(rt); out.push(rt); }
    }
    return out;
  }

  /** ESM execution order from `entry`: DFS post-order of the import graph so a
   *  module's dependencies are evaluated before it. Cycles break at the back-edge
   *  (the module already on the visit stack), matching ESM/rolldown semantics. */
  private computeModuleOrder(entry: ts.SourceFile): ts.SourceFile[] {
    const order: ts.SourceFile[] = [];
    const done = new Set<ts.SourceFile>();
    const onStack = new Set<ts.SourceFile>();
    const stack: ts.SourceFile[] = [];
    const visit = (sf: ts.SourceFile) => {
      if (done.has(sf)) return;
      if (onStack.has(sf)) {
        // Back-edge to a module still being visited: every module on the stack
        // from `sf` to the top forms an import cycle. Record them all.
        const idx = stack.lastIndexOf(sf);
        for (let i = idx; i < stack.length; i++) this.cyclicModules.add(stack[i]);
        return;
      }
      onStack.add(sf);
      stack.push(sf);
      for (const d of this.moduleDeps(sf, true)) visit(d);
      stack.pop();
      onStack.delete(sf);
      done.add(sf);
      order.push(sf);
    };
    const prelude = nodePreludeFile !== undefined ? this.program.getSourceFile(nodePreludeFile) : undefined;
    if (prelude && prelude !== entry) visit(prelude);   // the Node globals exist before any module runs
    visit(entry);
    // a module only type-only imports reach provides types: it is neither evaluated nor compiled
    const live = new Set<ts.SourceFile>();
    const pending: ts.SourceFile[] = [entry];
    if (prelude) pending.push(prelude);
    while (pending.length > 0) {
      const sf = pending.pop()!;
      if (live.has(sf)) continue;
      live.add(sf);
      for (const d of this.moduleDeps(sf, true)) pending.push(d);
    }
    return order.filter((sf) => live.has(sf));
  }

  /** True if `stmts` contain a top-level `await` (an await — or a `for await`
   *  loop — not inside any nested function). Such a module's __module_init is
   *  lowered as an async coroutine. */
  private hasTopLevelAwait(stmts: ts.Statement[]): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isAwaitExpression(n)) { found = true; return; }
      if (ts.isForOfStatement(n) && n.awaitModifier) { found = true; return; }
      if (isFunctionLike(n)) return; // a nested function's awaits are its own
      n.forEachChild(visit);
    };
    for (const s of stmts) visit(s);
    return found;
  }

  run(sf: ts.SourceFile) {
    this.modules = this.computeModuleOrder(sf);
    this.modules.forEach((module, index) => this.moduleInitializationOrder.set(module, index));
    this.sf = sf;
    for (const m of this.modules) this.preflightRuntimeSyntax(m);
    for (const m of this.modules) this.assignIds(m);
    this.setupClasses(sf);

    // Bindings in module-level blocks and loop heads also belong to module
    // initialization. They can be captured even though they are not exports.
    const registerOwned = (node: ts.Node) => {
      if (isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
      if (ts.isVariableDeclaration(node)) {
        const list = node.parent;
        const isGlobalVar = this.sourceMode === "script" && ts.isVariableDeclarationList(list) &&
          (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
        const bind = (name: ts.BindingName) => {
          if (ts.isIdentifier(name)) {
            const sym = this.symbolOf(name);
            if (sym) {
              this.moduleScopeSyms.add(sym);
              if (isGlobalVar) {
                this.scriptGlobalVarSyms.add(sym);
                this.scriptGlobalVarNames.add(name.text);
              }
            }
          } else for (const el of name.elements) if (ts.isBindingElement(el)) bind(el.name);
        };
        bind(node.name);
      }
      ts.forEachChild(node, registerOwned);
    };
    for (const module of this.modules) registerOwned(module);

    // Step C: collect module-scope binding symbols (top-level var/let/const +
    // top-level function/class names) across EVERY module. These are owned by the
    // single __module_init (rolldown-style scope hoisting into one scope).
    for (const sf of this.modules) for (const stmt of sf.statements) {
      // `declare var` binds nothing in the module: the environment's global
      if (ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent) && !(stmt.flags & AMBIENT_NODE_FLAG)) {
        const isVar =
          !(stmt.declarationList.flags & ts.NodeFlags.Let) &&
          !(stmt.declarationList.flags & ts.NodeFlags.Const);
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            const s = this.symbolOf(d.name);
            if (s) {
              this.moduleScopeSyms.add(s);
              if (this.sourceMode === "script" && isVar) {
                this.scriptGlobalVarSyms.add(s);
                this.scriptGlobalVarNames.add(d.name.text);
              } else {
                this.moduleTopBindingByName.set(d.name.text, s);
              }
            }
          }
        }
      } else if (this.isValueDefaultExport(stmt)) {
        const s = this.defaultExportSymbolOf(stmt);
        if (s) this.moduleScopeSyms.add(s);
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const s = this.symbolOf(stmt.name);
        if (s) {
          this.moduleScopeSyms.add(s);
          if (this.sourceMode === "script") {
            this.scriptGlobalVarSyms.add(s);
            this.scriptGlobalVarNames.add(stmt.name.text);
          } else {
            this.moduleTopBindingByName.set(stmt.name.text, s);
            if (stmt.body && !this.functionValueGlobal.has(s)) {
              const gid = this.internGlobal(`__fn_${stmt.name.text}_${this.bindingIdOf(s)}`);
              this.functionValueGlobal.set(s, gid);
            }
          }
        }
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        const s = this.symbolOf(stmt.name);
        if (s) { this.moduleScopeSyms.add(s); this.moduleTopBindingByName.set(stmt.name.text, s); }
      } else if (ts.isEnumDeclaration(stmt)) {
        // An enum binds a runtime object at module scope, captured like a class.
        const s = this.symbolOf(stmt.name);
        if (s) { this.moduleScopeSyms.add(s); this.moduleTopBindingByName.set(stmt.name.text, s); }
      } else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name) && this.isValueNamespace(stmt)) {
        // A value namespace binds a runtime object at module scope (like an enum),
        // UNLESS it merges with a same-named class (then the class binding holds it
        // and the namespace members live on the class's static container).
        const s = this.symbolOf(stmt.name);
        if (s && !this.classSymToId.has(s)) { this.moduleScopeSyms.add(s); this.moduleTopBindingByName.set(stmt.name.text, s); }
        // Its (inline-lowered) member bindings are owned by __module_init too.
        this.registerNamespaceMemberSyms(stmt);
      }
    }
    // Namespace getters need owned export cells even when no ordinary function
    // refers to a binding. The namespace binding itself can escape into closures.
    for (const module of this.modules) for (const stmt of module.statements) {
      const name = this.namespaceBindingName(stmt);
      if (!name) continue;
      const modSym = this.symbolOf(name);
      if (!modSym) continue;
      this.moduleScopeSyms.add(modSym);
      this.cellBindings.add(modSym);
      for (const exp of this.checker.getExportsOfModule(modSym)) {
        const canonical = this.unwrapImportAlias(exp) ?? exp;
        if (canonical.valueDeclaration && this.moduleScopeSyms.has(canonical)) this.cellBindings.add(canonical);
      }
    }
    for (const m of this.modules) this.collectMutatedGlobalRefs(m);
    this.collectUnsafeFieldStores();

    // Step C: synthesize __module_init from top-level non-declaration statements.
    // The statements keep their original parent chain (SourceFile), so the TS
    // checker resolves symbols correctly. Module-scope `var`/`let`/`const`
    // declared inside become cells owned by __module_init (via symbolOwnerFunction
    // redirection), captured by nested top-level functions.
    const allTopStmts = this.modules.flatMap((m) => [...m.statements]);
    const topLevelFunctionDecls = allTopStmts.filter(
      (stmt): stmt is ts.FunctionDeclaration => ts.isFunctionDeclaration(stmt) && !!stmt.body,
    );
    const needsModuleInitFor = (stmt: ts.Statement): boolean => {
      if (stmt.flags & AMBIENT_NODE_FLAG) return false;   // declarations of the environment's values
      if (ts.isFunctionDeclaration(stmt)) return this.sourceMode === "script" && !!stmt.body;
      if (ts.isClassDeclaration(stmt)) return true;
      if (ts.isInterfaceDeclaration(stmt)) return false;
      if (ts.isTypeAliasDeclaration(stmt)) return false;
      if (ts.isEnumDeclaration(stmt)) return true; // builds a runtime object binding
      if (ts.isModuleDeclaration(stmt)) return ts.isIdentifier(stmt.name) && this.isValueNamespace(stmt); // value namespace -> runtime object
      if (ts.isImportDeclaration(stmt)) return this.isNamespaceImportStmt(stmt); // import * as ns -> object
      if (ts.isExportDeclaration(stmt)) return this.namespaceBindingName(stmt) !== undefined; // export * as ns -> object
      if (ts.isExportAssignment(stmt)) return this.isValueDefaultExport(stmt); // export default <expression> -> a binding
      if (ts.isImportEqualsDeclaration(stmt)) return false;
      if (stmt.kind === ts.SyntaxKind.EmptyStatement) return false;
      return true;
    };
    const needsModuleInit = allTopStmts.some(needsModuleInitFor);
    // rolldown scope hoisting: concatenate EVERY module's top-level statements in
    // execution order (deps first). Each statement keeps its own SourceFile parent
    // so symbol/position resolution stays per-module-correct.
    const moduleStmts: ts.Statement[] = [];
    for (const stmt of allTopStmts) {
      if (stmt.flags & AMBIENT_NODE_FLAG) continue;
      if (ts.isFunctionDeclaration(stmt)) {
        if (stmt.body && (this.sourceMode === "script" || needsModuleInit)) moduleStmts.push(stmt);
        continue;
      }
      if (ts.isClassDeclaration(stmt)) {
        // Class declarations now create a stable constructor value at runtime.
        // Keep every top-level class in __module_init, not only classes with
        // statics, so the binding is initialized once in source order.
        moduleStmts.push(stmt);
        continue;
      }
      if (ts.isInterfaceDeclaration(stmt)) continue;
      if (ts.isTypeAliasDeclaration(stmt)) continue;
      if (ts.isEnumDeclaration(stmt)) { moduleStmts.push(stmt); continue; }
      if (ts.isModuleDeclaration(stmt)) { if (ts.isIdentifier(stmt.name) && this.isValueNamespace(stmt)) moduleStmts.push(stmt); continue; }
      if (ts.isImportDeclaration(stmt)) { if (this.isNamespaceImportStmt(stmt)) moduleStmts.push(stmt); continue; }
      if (ts.isExportDeclaration(stmt)) { if (this.namespaceBindingName(stmt) !== undefined) moduleStmts.push(stmt); continue; }
      if (ts.isExportAssignment(stmt)) { if (this.isValueDefaultExport(stmt)) moduleStmts.push(stmt); continue; }
      if (ts.isImportEqualsDeclaration(stmt)) continue;
      if (stmt.kind === ts.SyntaxKind.EmptyStatement) continue;
      moduleStmts.push(stmt);
    }
    if (moduleStmts.length > 0) {
      const initBlock = ts.factory.createBlock(moduleStmts, true);
      // Top-level await → lower __module_init as an async coroutine.
      this.moduleInitIsAsync = this.hasTopLevelAwait(moduleStmts);
      const initMods = this.moduleInitIsAsync
        ? [ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword)]
        : undefined;
      const initFn = ts.factory.createFunctionDeclaration(
        initMods, undefined, "__module_init", undefined, [], undefined, initBlock,
      );
      (initFn as any).parent = sf;
      (initBlock as any).parent = initFn;
      this.moduleInitNode = initFn;
      this.moduleInitId = this.fnId.size;
      this.fnId.set(initFn, this.moduleInitId);
      this._fnNodeById = undefined; // invalidate reverse-map cache (now includes init)
    } else if (this.sourceMode !== "script" && topLevelFunctionDecls.length > 0) {
      const initBlock = ts.factory.createBlock(topLevelFunctionDecls, true);
      const initFn = ts.factory.createFunctionDeclaration(
        undefined, undefined, "__function_values_init", undefined, [], undefined, initBlock,
      );
      (initFn as any).parent = sf;
      (initBlock as any).parent = initFn;
      this.functionValuesInitNode = initFn;
      this.functionValuesInitId = this.fnId.size;
      this.fnId.set(initFn, this.functionValuesInitId);
      this._fnNodeById = undefined; // invalidate reverse-map cache (now includes init)
    }

    // seed cellBindings by computing free vars of every function-like (incl. the
    // synthetic __module_init, so module-var captures get cell-allocated).
    const allFns: FnLike[] = [];
    const walk = (n: ts.Node) => {
      if (isLiftable(n) && (!ts.isFunctionDeclaration(n) || n.body)) allFns.push(n);
      // Object-literal method-shorthand and accessor members are lifted functions
      // whose captures need cells (incl. the defineProperty `{ get() {} }` case).
      if ((ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) &&
          n.body && n.parent && ts.isObjectLiteralExpression(n.parent) &&
          n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ||
                     (ts.isComputedPropertyName(n.name) && this.isSymbolKeyExpr(n.name.expression)))) allFns.push(n as unknown as FnLike);
      n.forEachChild(walk);
    };
    for (const m of this.modules) walk(m);
    if (this.functionValuesInitNode) allFns.push(this.functionValuesInitNode as unknown as FnLike);
    if (this.moduleInitNode) allFns.push(this.moduleInitNode as unknown as FnLike);
    this.computeAssignedBindings();
    for (const f of allFns) for (const s of this.freeVars(f)) {
      this.cellBindings.add(s);
      let arr = this.capturedByFns.get(s);
      if (!arr) { arr = []; this.capturedByFns.set(s, arr); }
      arr.push(f);
    }
    // Class methods/ctors aren't in allFns, but a ctor's free vars now include its
    // field-initializer / dynamic-member captures (see freeVars). Any function-local
    // such binding must be cell-allocated in its OWNER function so the `new`/`super`
    // site can thread it into the Direct-called ctor (ctorCellArgs).
    for (const md of this.methodDecls) for (const s of this.freeVars(md.node as unknown as FnLike)) { this.cellBindings.add(s); this.cellOnlySyms.add(s); }
    // Installed dynamic/symbol methods are lifted as closures (lowerClosure) at the
    // install site (the ctor, or inline at `new` for a ctor-less class), capturing
    // from that site's cellAccess. Their function-local captures must therefore be
    // cells in the owning function too — even when the class has no explicit ctor.
    for (const cn of this.classNodeOfId.values())
      for (const m of cn.members)
        if (this.isDynComputedInstallMethod(m) || this.isDynComputedInstallAccessor(m)) for (const s of this.freeVars(m as unknown as FnLike)) { this.cellBindings.add(s); this.cellOnlySyms.add(s); }
    // A class WITHOUT an explicit constructor used as a class value runs its field
    // initializers in a synthesized ctor (synthClassValueCtor). Function-local
    // bindings those field inits capture must be cell-allocated in the owning
    // function so the value-creation site can thread them onto the value's env
    // (synthClassValueCaptures), mirroring the explicit-ctor methodDecls loop above
    // (a no-ctor class has no ctor in methodDecls, so it isn't covered there).
    for (const [cid, cn] of this.classNodeOfId) {
      if (this.ctorNodeOfClassId(cid)) continue; // explicit ctor: handled via methodDecls
      void cn;
      for (const s of this.synthCtorFreeVars(cid)) { this.cellBindings.add(s); this.cellOnlySyms.add(s); }
    }
    // Capture by value: an immutable binding leaves cellBindings (its owner keeps
    // a plain local) and is supplied to its closures as a value slot.
    for (const s of [...this.cellBindings]) {
      if (this.valueCapturable(s)) { this.cellBindings.delete(s); this.valueBindings.add(s); }
    }
    if (process.env.TSAOT_DEBUG_CELLS)
      console.error(`[cells] by value: [${[...this.valueBindings].map((s) => (s as { name?: string }).name ?? "?").join(",")}]`);

    // A NAMED (vtable) instance/static method or accessor that captures an
    // enclosing function's local cannot work: vtable/static dispatch has a fixed
    // ABI ([this, …args]) with no slot to thread the cell, so the body would read
    // garbage. (Constructors are exempt — they're Direct-called and DO thread cells
    // via emitCtorCall; module-scope captures are exempt — read via GLOBALS.)
    // Loud-reject instead of silently miscompiling.
    for (const md of this.methodDecls) {
      if (ts.isConstructorDeclaration(md.node)) continue;
      if (this.anyFunctionLocalCapture(this.freeVars(md.node as unknown as FnLike))) {
        this.unsupported(md.node, "class method/accessor that captures an enclosing function's local (vtable/static dispatch can't thread the cell; only constructors, field initializers, and dynamic-keyed members capture function-locals — move the class to module scope or pass the value in)");
      }
    }

    // Step E: any module-scope binding captured by a METHOD body must be
    // published into a GLOBALS[] slot (methods can't receive cell params via the
    // vtable ABI). Assign each such binding a GlobalId now; __module_init stores
    // the cell there, and method reads load it from there.
    for (const md of this.methodDecls) {
      for (const s of this.freeVars(md.node as unknown as FnLike)) {
        if (!this.isScriptGlobalVarSymbol(s) && this.moduleScopeSyms.has(s) && !this.moduleCellGlobal.has(s)) {
          const gid = this.internGlobal(`__modcell_${(s as any).name ?? "v"}_${this.bindingId.get(s) ?? this.moduleCellGlobal.size}`);
          this.moduleCellGlobal.set(s, gid);
          this.cellBindings.add(s); // ensure it's cell-allocated in __module_init
        }
      }
    }

    // Step F: static field initializers and static blocks live in synthesized
    // __static_init functions (separate from __module_init), so the AST-based
    // free-var walk above doesn't see them. Scan each class's static
    // initializers/blocks for module-scope references and publish those bindings
    // as module cells too, so the static-init body reads them via LoadGlobal.
    const registerModuleRef = (id: ts.Identifier) => {
      if (!this.isVarRef(id)) return;
      const s = this.symbolOf(id);
      if (s && !this.isScriptGlobalVarSymbol(s) && this.moduleScopeSyms.has(s) && !this.moduleCellGlobal.has(s)) {
        const gid = this.internGlobal(`__modcell_${(s as any).name ?? "v"}_${this.bindingId.get(s) ?? this.moduleCellGlobal.size}`);
        this.moduleCellGlobal.set(s, gid);
        this.cellBindings.add(s);
      }
    };
    const scanStaticForModuleRefs = (n: ts.Node) => {
      if (ts.isIdentifier(n)) { registerModuleRef(n); return; }
      // descend, but skip nested function-likes (their own captures are handled
      // by the methodDecls walk / lowerClosure path).
      if (isFunctionLike(n)) return;
      n.forEachChild(scanStaticForModuleRefs);
    };
    for (const si of this.staticInits) {
      for (const m of si.node.members) {
        // Static dynamic/symbol-keyed members are installed in __static_init too:
        // their KEY expression (e.g. a module-const `Symbol()`), method/accessor
        // body, and field initializer must all have their module refs published —
        // else the key/init reads an empty local at static-init time.
        if (this.isStaticMember(m) && this.isDynComputedMember(m)) {
          const nm = (m as { name?: ts.PropertyName }).name;
          if (nm && ts.isComputedPropertyName(nm)) scanStaticForModuleRefs(nm.expression);
          if ((ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.body) scanStaticForModuleRefs(m.body);
          if (ts.isPropertyDeclaration(m) && m.initializer) scanStaticForModuleRefs(m.initializer);
        } else if (this.isStaticMember(m) && ts.isPropertyDeclaration(m) && m.initializer) {
          scanStaticForModuleRefs(m.initializer);
        } else if (ts.isClassStaticBlockDeclaration(m)) {
          scanStaticForModuleRefs(m.body);
        }
      }
    }

    // Step F': INSTANCE field initializers + dynamic/symbol computed member keys
    // and installed dynamic-method bodies are lowered into the constructor (or
    // inline at the `new` site), so module-scope bindings they reference must be
    // published as module cells too (read via LoadGlobal). Without this, a
    // `class C { x = MODULE_CONST; constructor(){} }` field init — or an
    // explicit-ctor `[k](){}` — would read an empty local. (Function-local
    // captures are not published here and are loud-rejected in emitFieldInitializers.)
    for (const cnode of this.classNodeOfId.values()) {
      for (const m of cnode.members) {
        if (this.isStaticMember(m)) continue;
        if (this.isDynComputedMember(m)) {
          const nm = (m as { name?: ts.PropertyName }).name;
          if (nm && ts.isComputedPropertyName(nm)) scanStaticForModuleRefs(nm.expression);
          if (ts.isMethodDeclaration(m) && m.body) scanStaticForModuleRefs(m.body);
          if (ts.isPropertyDeclaration(m) && m.initializer) scanStaticForModuleRefs(m.initializer);
        } else if (ts.isPropertyDeclaration(m) && m.initializer) {
          scanStaticForModuleRefs(m.initializer);
        }
      }
    }

    // Capture contexts: group the record-resident captured bindings per owner
    // and declare the scope record classes (the cell binding set is final here).
    this.buildCaptureRecords();
    this.computeFunctionValueUses();

    // lower top-level function declarations of EVERY module; nested ones lifted on demand
    for (const sf of this.modules) for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        const isExported = !!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        this.lowerFunctionLike(stmt, this.fnId.get(stmt)!, isExported);
      }
    }

    // Top-level module linkage across every module: erase type-only + (bundler)
    // resolve value imports/exports; loud-reject the unsupported forms.
    for (const sf of this.modules) for (const stmt of sf.statements) {
      this.tryHandleLinkage(stmt);
    }

    // Stable boxed top-level function values for function-only modules where the
    // legacy entry policy still calls `main` directly (no __module_init).
    if (this.functionValuesInitNode && this.functionValuesInitId !== undefined) {
      this.lowerFunctionLike(this.functionValuesInitNode as unknown as FnLike, this.functionValuesInitId, false);
    }

    // Step C: lower __module_init (runs top-level statements; owns module cells).
    if (this.moduleInitNode && this.moduleInitId !== undefined) {
      this.lowerFunctionLike(this.moduleInitNode as unknown as FnLike, this.moduleInitId, false);
    }

    // lift class method bodies. Static members (thisName === "") are lowered with a
    // plain-object `this` parameter (staticThis: the receiver "class object"/static
    // container, takes_this=1); instance methods/getters/setters/ctors take a typed
    // `this`.
    for (const md of this.methodDecls) {
      if (md.thisName === "") {
        this.lowerFunctionLike(md.node as FnLike, md.fnId, false, /*thisParam*/ false, md.classId, /*staticThis*/ true);
      } else {
        this.lowerMethod(md.node, md.fnId, md.classId);
      }
    }

    // Step F: synthesize and lower __static_init_<classId> for each class with
    // statics. Creates the container object, publishes it to the class's global
    // slot, then runs static field initializers and static blocks in source order.
    for (const si of this.staticInits) {
      this.lowerStaticInit(si.classId, si.fnId, si.node);
    }
    this.drainPendingNested();

    this.buildClassesTable();
  }

  programJson() {
    this.functions.sort((a, b) => a.id - b.id);
    for (let i = 1; i < this.functions.length; i++) {
      if (this.functions[i - 1].id === this.functions[i].id)
        throw new Error(`duplicate IR function id ${this.functions[i].id}: ${this.functions[i - 1].name}, ${this.functions[i].name}`);
    }
    // Object.prototype methods: pre-intern their method-name ids so the runtime
    // can register C implementations on the shared Object.prototype under the
    // same METHOD_KEY_BASE + id that dynamic dispatch (o.toString()) will use.
    const objectProtoMethods = [
      { name: "toString", runtime: "ts_objproto_toString", methodId: this.internName("toString") },
      { name: "toLocaleString", runtime: "ts_objproto_toLocaleString", methodId: this.internName("toLocaleString") },
      { name: "valueOf", runtime: "ts_objproto_valueOf", methodId: this.internName("valueOf") },
      { name: "hasOwnProperty", runtime: "ts_objproto_hasOwnProperty", methodId: this.internName("hasOwnProperty") },
      { name: "isPrototypeOf", runtime: "ts_objproto_isPrototypeOf", methodId: this.internName("isPrototypeOf") },
      { name: "propertyIsEnumerable", runtime: "ts_objproto_propertyIsEnumerable", methodId: this.internName("propertyIsEnumerable") },
    ];
    // Array.prototype methods (unified object model): each maps a method NAME to
    // its runtime ts_code wrapper and the program's interned method-name id, so
    // emitted setup registers it on the runtime Array.prototype under
    // TS_KEY_METHOD(id). This lets a dynamic `arr.method()` (e.g. on an any-typed
    // array) resolve through the prototype chain to the same builtins the static
    // fast path uses. Registered for every method (internName assigns ids); the
    // proto is shared so the cost is one-time setup, not per-array.
    const arrayProtoSpec: [string, string][] = [
      ["join","ts_arrproto_join"],["indexOf","ts_arrproto_indexOf"],["includes","ts_arrproto_includes"],
      ["lastIndexOf","ts_arrproto_lastIndexOf"],["slice","ts_arrproto_slice"],["concat","ts_arrproto_concat"],
      ["pop","ts_arrproto_pop"],["push","ts_arrproto_push"],["shift","ts_arrproto_shift"],
      ["unshift","ts_arrproto_unshift"],["reverse","ts_arrproto_reverse"],["at","ts_arrproto_at"],
      ["fill","ts_arrproto_fill"],["flat","ts_arrproto_flat"],["sort","ts_arrproto_sort"],["splice","ts_arrproto_splice"],["toString","ts_arrproto_toString"],
      ["map","ts_arrproto_map"],["filter","ts_arrproto_filter"],["forEach","ts_arrproto_forEach"],
      ["reduce","ts_arrproto_reduce"],["reduceRight","ts_arrproto_reduceRight"],["copyWithin","ts_arrproto_copyWithin"],["find","ts_arrproto_find"],["findIndex","ts_arrproto_findIndex"],
      ["findLast","ts_arrproto_findLast"],["findLastIndex","ts_arrproto_findLastIndex"],
      ["some","ts_arrproto_some"],["every","ts_arrproto_every"],["flatMap","ts_arrproto_flatMap"],
      ["keys","ts_arrproto_keys"],["values","ts_arrproto_values"],["entries","ts_arrproto_entries"],
      ["toSorted","ts_arrproto_toSorted"],["toReversed","ts_arrproto_toReversed"],["with","ts_arrproto_with"],["toSpliced","ts_arrproto_toSpliced"],
    ];
    const arrayProtoMethods = arrayProtoSpec.map(([name, runtime]) => ({
      name, runtime, methodId: this.internName(name),
    }));
    // Map.prototype / Set.prototype methods (followon to U-5): same mechanism as
    // arrayProtoMethods. `size` is a property (not a method) so it is excluded.
    const mapProtoSpec: [string, string][] = [
      ["set","ts_mapproto_set"],["get","ts_mapproto_get"],["has","ts_mapproto_has"],
      ["delete","ts_mapproto_delete"],["clear","ts_mapproto_clear"],["keys","ts_mapproto_keys"],
      ["values","ts_mapproto_values"],["entries","ts_mapproto_entries"],["forEach","ts_mapproto_forEach"],
    ];
    const setProtoSpec: [string, string][] = [
      ["add","ts_setproto_add"],["has","ts_setproto_has"],["delete","ts_setproto_delete"],
      ["clear","ts_setproto_clear"],["keys","ts_setproto_keys"],["values","ts_setproto_values"],
      ["entries","ts_setproto_entries"],["forEach","ts_setproto_forEach"],
    ];
    const weakMapProtoSpec: [string, string][] = [
      ["set","ts_weakmapproto_set"],["get","ts_weakmapproto_get"],
      ["has","ts_weakmapproto_has"],["delete","ts_weakmapproto_delete"],
    ];
    const weakSetProtoSpec: [string, string][] = [
      ["add","ts_weaksetproto_add"],["has","ts_weaksetproto_has"],
      ["delete","ts_weaksetproto_delete"],
    ];
    const headersProtoSpec: [string, string][] = [
      ["get","ts_headersproto_get"],["has","ts_headersproto_has"],["keys","ts_headersproto_keys"],
      ["values","ts_headersproto_values"],["entries","ts_headersproto_entries"],
      ["append","ts_headersproto_append"],["set","ts_headersproto_set"],["delete","ts_headersproto_delete"],
    ];
    const mapProtoMethods = mapProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    const setProtoMethods = setProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    const weakMapProtoMethods = weakMapProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    const weakSetProtoMethods = weakSetProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    const headersProtoMethods = headersProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    // Promise.prototype methods: then/catch/finally as first-class method VALUES.
    // ts_get on a promise resolves these via the shared Promise.prototype (the
    // `p.then(cb)` call form uses the direct CallBuiltin "promise.then" fast path).
    const promiseProtoSpec: [string, string][] = [
      ["then","ts_promiseproto_then"],["catch","ts_promiseproto_catch"],["finally","ts_promiseproto_finally"],
    ];
    const promiseProtoMethods = promiseProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    // Function.prototype methods: call/apply/bind (this = args[0] = the function).
    const functionProtoSpec: [string, string][] = [
      ["call","ts_funcproto_call"],["apply","ts_funcproto_apply"],["bind","ts_funcproto_bind"],
    ];
    const functionProtoMethods = functionProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    // String.prototype methods: lets a method call on an any-typed string
    // (`(x as any).toUpperCase()`) resolve through the prototype chain to the same
    // builtins the statically-typed fast path uses (this = args[0] = the string).
    const stringProtoSpec: [string, string][] = [
      ["toUpperCase","ts_strproto_toUpperCase"],["toLowerCase","ts_strproto_toLowerCase"],
      ["toLocaleUpperCase","ts_strproto_toLocaleUpperCase"],["toLocaleLowerCase","ts_strproto_toLocaleLowerCase"],
      ["slice","ts_strproto_slice"],["substring","ts_strproto_substring"],
      ["substr","ts_strproto_substr"],["toString","ts_strproto_toString"],["valueOf","ts_strproto_toString"],
      ["indexOf","ts_strproto_indexOf"],["lastIndexOf","ts_strproto_lastIndexOf"],
      ["includes","ts_strproto_includes"],["startsWith","ts_strproto_startsWith"],
      ["endsWith","ts_strproto_endsWith"],["charAt","ts_strproto_charAt"],
      ["charCodeAt","ts_strproto_charCodeAt"],["codePointAt","ts_strproto_codePointAt"],["at","ts_strproto_at"],
      ["isWellFormed","ts_strproto_isWellFormed"],["toWellFormed","ts_strproto_toWellFormed"],
      ["normalize","ts_strproto_normalize"],
      ["concat","ts_strproto_concat"],["repeat","ts_strproto_repeat"],
      ["trim","ts_strproto_trim"],["trimStart","ts_strproto_trimStart"],
      ["trimEnd","ts_strproto_trimEnd"],["trimLeft","ts_strproto_trimLeft"],
      ["trimRight","ts_strproto_trimRight"],["split","ts_strproto_split"],
      ["padStart","ts_strproto_padStart"],["padEnd","ts_strproto_padEnd"],
      ["replace","ts_strproto_replace"],["replaceAll","ts_strproto_replaceAll"],
      ["match","ts_strproto_match"],["matchAll","ts_strproto_matchAll"],["search","ts_strproto_search"],
    ];
    const stringProtoMethods = stringProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    // Number.prototype methods: same dynamic-dispatch enablement for an any-typed
    // number (`(x as any).toFixed(2)`). this = args[0] = the number value.
    const numberProtoSpec: [string, string][] = [
      ["toFixed","ts_numproto_toFixed"],["toString","ts_numproto_toString"],
      ["toPrecision","ts_numproto_toPrecision"],["toExponential","ts_numproto_toExponential"],
      ["valueOf","ts_numproto_valueOf"],
    ];
    const numberProtoMethods = numberProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    const booleanProtoSpec: [string, string][] = [
      ["toString","ts_boolproto_toString"],["valueOf","ts_boolproto_valueOf"],
    ];
    const booleanProtoMethods = booleanProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    const regexpProtoSpec: [string, string][] = [
      ["test","ts_regexpproto_test"],["exec","ts_regexpproto_exec"],
    ];
    const regexpProtoMethods = regexpProtoSpec.map(([name, runtime]) => ({ name, runtime, methodId: this.internName(name) }));
    // Well-known symbol methods (§3.6): map the method-name id the exporter
    // assigned to "@@iterator"/"@@asyncIterator" to its stable wksym id, so codegen
    // emits TS_KEY_WKSYM(id) (a fixed key in the reserved WKSYM range) rather than a
    // position-dependent method-name key. Only emitted for names actually interned.
    const wkSymTable: { magic: string; wksymId: number }[] = [
      { magic: "@@iterator", wksymId: 0 },        // TS_WKSYM_ITERATOR
      { magic: "@@asyncIterator", wksymId: 1 },   // TS_WKSYM_ASYNC_ITERATOR
    ];
    const wellKnownSymbols = wkSymTable
      .filter((w) => this.nameIntern.has(w.magic))
      .map((w) => ({ nameId: this.nameIntern.get(w.magic)!, wksymId: w.wksymId }));
    if (this.hasDynamicDelete) {
      // Resolve both property-key namespaces after every method name is known.
      const pairs = [...this.nameIntern].map(([name, id]) => `${this.internField(name)},${id}`).join(";");
      const resolve = (body: any[]) => {
        for (const inst of body) {
          if (inst.kind === "CallBuiltinStatic" && inst.builtin === "object.deleteDynamic")
            inst.builtin += ":" + pairs;
          for (const key of ["thenBody", "elseBody", "condBody", "body", "tryBody", "catchBody", "finallyBody"])
            if (Array.isArray(inst[key])) resolve(inst[key]);
        }
      };
      for (const fn of this.functions) resolve(fn.body);
    }
    return {
      version: 1,
      strictTypeOptimizations: this.strictTypeOptimizationProfile(),
      closedReceivers: process.env.TSAOT_CLOSED_RECEIVERS === "0"
        ? { closed: false, reasons: ["TSAOT_CLOSED_RECEIVERS=0"], count: 0 }
        : this.closedReceivers,
      types: [],
      fields: this.fields,
      signatures: [],
      globals: this.globals,
      scopes: [],
      bindings: [],
      functions: this.functions,
      modules: this.relativeModuleNames(),
      functionModules: Object.fromEntries(this.fnModule),
      exports: this.exports,
      siteMeta: this.siteMeta,
      classes: this.classesOut,
      objectProtoMethods,
      arrayProtoMethods,
      promiseProtoMethods,
      mapProtoMethods,
      setProtoMethods,
      weakMapProtoMethods,
      weakSetProtoMethods,
      headersProtoMethods,
      functionProtoMethods,
      stringProtoMethods,
      regexpProtoMethods,
      numberProtoMethods,
      booleanProtoMethods,
      wellKnownSymbols,
    };
  }
}

function exportOne(program: ts.Program, input: string, progOut: string, labelOut: string, sourceMode: SourceMode = "module"): { ok: boolean; nfns: number; unsupported: string[] } {
  const sf = program.getSourceFile(input);
  if (!sf) return { ok: false, nfns: 0, unsupported: [`source not found: ${input}`] };
  const ex = new Exporter(program, sourceMode);
  ex.run(sf);
  const prog = ex.programJson();
  ex.printStaticSlotLog();
  fs.writeFileSync(progOut, JSON.stringify(toWireProgram(prog), null, 2));
  fs.writeFileSync(labelOut, JSON.stringify(ex.labels, null, 2));
  const spansOut = labelOut.replace(/labels\.json$|\.json$/, "") + "sites.json";
  fs.writeFileSync(spansOut, JSON.stringify(ex.siteSpans, null, 2));
  return { ok: ex.unsupportedList.length === 0, nfns: prog.functions.length, unsupported: ex.unsupportedList };
}

// Batch mode: `node exporter.js --batch <list.tsv> <outdir>`.
// list.tsv lines: <name>\t<input.ts path>
// Each benchmark gets its OWN ts.Program (so global-script files don't collide
// in a shared global scope — they all declare top-level `main`/classes), but a
// shared CompilerHost caches the parsed lib.*.d.ts SourceFiles so the heavy lib
// load happens once. Per-file cost drops from ~1.8s (fresh node+lib per file) to
// ~18ms after warmup — fast AND correct.
function batchMain(listPath: string, outDir: string, strictCompiler = false) {
  const lines = fs.readFileSync(listPath, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const entries = lines.map((l) => { const [name, input] = l.split("\t"); return { name, input }; });
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const opts: ts.CompilerOptions = baseCompilerOptions(strictCompiler);
  const libCache = new Map<string, ts.SourceFile | undefined>();
  const baseHost = ts.createCompilerHost(opts);
  const host: ts.CompilerHost = Object.assign({}, baseHost, {
    getSourceFile(fileName: string, languageVersion: ts.ScriptTarget, onError?: (m: string) => void) {
      if (libCache.has(fileName)) return libCache.get(fileName);
      const sf = baseHost.getSourceFile(fileName, languageVersion, onError);
      if (/lib\..*\.d\.ts$/.test(fileName)) libCache.set(fileName, sf); // libs never change
      return sf;
    },
  });
  for (const e of entries) {
    try {
      const program = programWithJsxRuntime([e.input], opts, host, "module");
      const r = exportOne(program, e.input, `${outDir}/${e.name}.program.json`, `${outDir}/${e.name}.labels.json`);
      const status = r.ok ? "OK" : "UNSUPPORTED";
      process.stdout.write(`${e.name}\t${status}\t${r.nfns}\n`);
      if (!r.ok) for (const u of r.unsupported) process.stderr.write(`  [${e.name}] - ${u}\n`);
    } catch (err) {
      process.stdout.write(`${e.name}\tERROR\t0\n`);
      process.stderr.write(`  [${e.name}] ${(err as Error).message}\n`);
    }
  }
}

function main() {
  let argv = process.argv.slice(2);
  let strictCompiler = false;
  let project: string | undefined;
  while (argv[0] === "--strict" || argv[0] === "--project" || argv[0] === "-p") {
    if (argv[0] === "--strict") {
      strictCompiler = true;
      argv = argv.slice(1);
    } else {
      if (!argv[1] || argv[1].startsWith("--")) {
        console.error("--project requires a tsconfig file or directory");
        process.exit(2);
      }
      project = path.resolve(argv[1]);
      argv = argv.slice(2);
    }
  }
  if (project && (argv[0] === "--batch" || argv[0] === "--transpile-batch")) {
    console.error("--project requires a single entry file");
    process.exit(2);
  }
  if (argv[0] === "--batch") {
    batchMain(argv[1], argv[2], strictCompiler);
    return;
  }
  if (argv[0] === "--transpile-batch") {
    // `node exporter.js --transpile-batch <list.tsv> <outdir>`: strip types from
    // each .ts (no type-checking, fast) to produce a runnable .js V8 reference,
    // appending a main() call. Used by the conformance harness to derive the V8
    // oracle from the same source the AOT path compiles.
    const lines = fs.readFileSync(argv[1], "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const outDir = argv[2];
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    // Run the V8 reference as a real ES MODULE (matching how tsaot compiles the
    // input: `module: ESNext`). A `package.json {type:module}` makes node treat the
    // emitted `.js` as ESM, so the oracle observes ESM semantics — always-strict
    // (writes to frozen/non-extensible objects throw), top-level `this===undefined`,
    // and top-level `await` — exactly the semantics the AOT path emulates.
    fs.writeFileSync(`${outDir}/package.json`, '{"type":"module"}\n');
    for (const l of lines) {
      const [name, input] = l.split("\t");
      try {
        const src = fs.readFileSync(input, "utf8");
        const out = ts.transpileModule(src, {
          fileName: input,   // a .tsx file parses JSX
          compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: oracleJsxEmit(src) },
        }).outputText;
        // Step 0(b)/Step C: the V8 reference NO LONGER auto-appends a main()
        // call. ESM semantics: the program runs its top-level statements only.
        // Test files now carry an explicit top-level `main();` (Step 0(c)
        // migration), which both the V8 reference (here) and the AOT path
        // (__module_init) execute exactly once.
        fs.writeFileSync(`${outDir}/${name}.js`, out + "\n");
        process.stdout.write(`${name}\tOK\n`);
      } catch (err) {
        process.stdout.write(`${name}\tERROR\n`);
        process.stderr.write(`  [${name}] ${(err as Error).message}\n`);
      }
    }
    return;
  }
  const sourceMode: SourceMode = argv[0] === "--script" ? "script" : "module";
  const positional = sourceMode === "script" ? argv.slice(1) : argv;
  const [input, progOut, labelOut] = positional;
  if (!input) {
    console.error("usage: node exporter.js <input.ts> <program.json> <labels.json>");
    console.error("   or: node exporter.js --strict <input.ts> <program.json> <labels.json>");
    console.error("   or: node exporter.js --project <tsconfig> <input.ts> <program.json> <labels.json>");
    console.error("   or: node exporter.js --script <input.ts> <program.json> <labels.json>");
    console.error("   or: node exporter.js --strict --script <input.ts> <program.json> <labels.json>");
    console.error("   or: node exporter.js [--strict] --batch <list.tsv> <outdir>");
    process.exit(1);
  }
  let compilerOptions = baseCompilerOptions(strictCompiler);
  const rootNames = [input];
  if (project) {
    const configFile = ts.sys.directoryExists(project) ? path.join(project, "tsconfig.json") : project;
    const report = (diagnostics: readonly ts.Diagnostic[]) => {
      process.stderr.write(ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: f => f,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => ts.sys.newLine,
      }));
      process.exit(2);
    };
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    if (config.error) report([config.error]);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile), undefined, configFile);
    if (parsed.errors.length) report(parsed.errors);
    rootNames.push(...parsed.fileNames.filter(f => /\.d\.[cm]?ts$/.test(f)));
    compilerOptions = { ...compilerOptions, ...parsed.options };
    // garnet compiles every program as ES modules bundled whole: a project's Node module kinds
    // (Node16/NodeNext, whose CommonJS detection by package.json would make garnet's own library
    // files CommonJS and reject their ESM syntax under verbatimModuleSyntax) are compiled as ESNext
    // with Bundler resolution, which resolves the same `.js` -> `.ts` specifiers, package `exports`
    // and custom conditions
    if (compilerOptions.module !== undefined && (ts.ModuleKind[compilerOptions.module] ?? "").startsWith("Node")) {
      compilerOptions.module = ts.ModuleKind.ESNext;
      compilerOptions.moduleResolution = ts.ModuleResolutionKind.Bundler;
    }
    compilerOptions.paths = { ...garnetModulePaths(), ...(compilerOptions.paths ?? {}) };
    // the globals garnet's runtime provides (console, TextEncoder, setTimeout, ...) are typed by lib.dom:
    // a project that lists its libs without it gets it added (the default libs of a target include it)
    if (compilerOptions.lib !== undefined && !compilerOptions.lib.some((l) => /dom/i.test(l))) compilerOptions.lib = [...compilerOptions.lib, "lib.dom.d.ts"];
    if (strictCompiler) compilerOptions.strict = true;
    // Garnet bundles the entry's source graph instead of emitting project
    // references/declarations. Keep resolution, libraries and checking options,
    // removing only TypeScript's output/build constraints.
    for (const key of ["composite", "incremental", "tsBuildInfoFile", "rootDir", "outDir", "outFile",
      "declaration", "declarationMap", "emitDeclarationOnly", "isolatedDeclarations", "sourceMap",
      "inlineSourceMap", "inlineSources"] as const) delete compilerOptions[key];
    compilerOptions.noEmit = true;
    compilerOptions.noCheck = false;
    compilerOptions.strictNullChecks = true;
    // JSX stays in the tree for the exporter's lowering; the automatic runtime's mode is kept (the checker
    // resolves `<jsxImportSource>/jsx-runtime` under it; the dev runtime is the production one here)
    compilerOptions.jsx = compilerOptions.jsx === ts.JsxEmit.ReactJSX || compilerOptions.jsx === ts.JsxEmit.ReactJSXDev
      ? ts.JsxEmit.ReactJSX : ts.JsxEmit.Preserve;
  }
  const program = programWithJsxRuntime(rootNames, compilerOptions, undefined, sourceMode);
  const sf = program.getSourceFile(input)!;
  // Type-error gate: the checker still assigns a type to every node when the
  // program is ill-typed, but those types are unsound — either the error type
  // (an `any`), or worse a concrete-but-false annotation type (`const n: number
  // = "s"` keeps `n: number`). The exporter's type-driven lowering trusts these
  // types, so ill-typed input is a silent-miscompile hazard. Refuse by default
  // (loud, before any lowering). The escape hatch is TSAOT_UNTYPED=1, which does
  // NOT trust the unsound types — it compiles the whole program as `any` (all
  // type-driven optimization off, everything boxed), so it is safe to run even
  // when ill-typed (correct JS semantics, just slower).
  if (process.env.TSAOT_UNTYPED !== "1") {
    const userFiles = program.getSourceFiles().filter((f) =>
      !f.isDeclarationFile &&
      !program.isSourceFileDefaultLibrary(f) &&
      !program.isSourceFileFromExternalLibrary(f));
    // garnet's own library files (lib/node, lib/garnet) are checked with the project's options; the
    // lint-only diagnostics a stricter project enables (unused names, override modifiers, the form of
    // type-only imports) are not type errors and do not block the compile; type errors in them do
    const libDir = path.resolve(__dirname, "..", "lib") + path.sep;
    const lintOnly = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205, 4114, 1484, 7027]);
    const diagnostics: ts.Diagnostic[] = [
      ...userFiles.flatMap((f) => program.getSyntacticDiagnostics(f)),
      ...userFiles.flatMap((f) => program.getSemanticDiagnostics(f)),
      ...program.getGlobalDiagnostics(),
      ...program.getOptionsDiagnostics(),
    ].filter((d) => !(d.file !== undefined && path.resolve(d.file.fileName).startsWith(libDir) && lintOnly.has(d.code)));
    if (diagnostics.length > 0) {
      const fmtHost: ts.FormatDiagnosticsHost = {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        getNewLine: () => ts.sys.newLine,
      };
      const formatted = process.stderr.isTTY
        ? ts.formatDiagnosticsWithColorAndContext(diagnostics, fmtHost)
        : ts.formatDiagnostics(diagnostics, fmtHost);
      process.stderr.write(formatted);
      const errs = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length;
      console.error(`\n${errs || diagnostics.length} type error(s). Refusing to compile ill-typed input ` +
        `(types are unsound under type errors — silent-miscompile hazard). ` +
        `Set TSAOT_UNTYPED=1 to compile in untyped (any) mode: all type-driven ` +
        `optimization is disabled, so it runs with correct JS semantics (slower, but safe).`);
      process.exit(2);
    }
  }
  const ex = new Exporter(program, sourceMode);
  ex.run(sf);
  const prog = ex.programJson();
  ex.printStaticSlotLog();
  fs.writeFileSync(progOut ?? "program.json", JSON.stringify(toWireProgram(prog), null, 2));
  fs.writeFileSync(labelOut ?? "labels.json", JSON.stringify(ex.labels, null, 2));
  const spansOut = (labelOut ?? "labels.json").replace(/labels\.json$|\.json$/, "") + "sites.json";
  fs.writeFileSync(spansOut, JSON.stringify(ex.siteSpans, null, 2));
  console.error(`exported ${prog.functions.length} functions, ${ex.site} alloc sites, ${ex.bindingId.size} cell bindings`);
  if (ex.unsupportedList.length > 0) {
    console.error(`\n${ex.unsupportedList.length} UNSUPPORTED construct(s):`);
    for (const u of ex.unsupportedList) console.error(`  - ${u}`);
    if (process.env.TSAOT_ALLOW_UNSUPPORTED !== "1") {
      console.error("\nRefusing to emit incomplete IR. Set TSAOT_ALLOW_UNSUPPORTED=1 to override.");
      process.exit(3);
    }
  }
}
main();
