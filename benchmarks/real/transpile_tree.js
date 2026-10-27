// The Node side of a real-project benchmark (benchmarks/real/run.sh): the TypeScript sources of a tree
// emitted as ES modules by the repo's TypeScript (a program emit, so a re-export of a type-only name is
// elided as the project's own build would; no bundler), the relative import specifiers rewritten to the
// emitted files (`./x` -> `./x.mjs`, `./x.js` and `./x.ts` -> `./x.mjs`, `./dir` -> `./dir/index.mjs`),
// so Node runs the same source garnet compiles.
//   node transpile_tree.js <source root> <out root> <entry.ts relative to root> [paths.json]
// The program is the entry's import graph under the project's compiler options (<root>/garnet-tsconfig.json
// when present, the options garnet compiled with); with paths.json, a map of bare specifiers to source
// files (the tsconfig's `paths` of a workspace) rewrites those too; other bare specifiers are left as is
// and reported.
const ts = require(process.env.ROOT + "/exporter/node_modules/typescript");
const fs = require("fs"), path = require("path");
const [root, out, entry] = process.argv.slice(2, 5).map((p, i) => (i < 2 ? path.resolve(p) : p));
const pathsMap = process.argv[5] ? JSON.parse(fs.readFileSync(process.argv[5], "utf8")) : {};
// the program's build-time constants (TSAOT_DEFINE, as garnet folds them: `__DEV__=false,__VERSION__="3.5.0"`),
// substituted for the bare identifiers in the emitted JavaScript, as the project's own bundler would
const defines = [];
for (const part of (process.env.TSAOT_DEFINE || "").split(",").map((p) => p.trim()).filter(Boolean)) {
  const m = /^([A-Za-z_$][\w$]*)=(.*)$/.exec(part);
  if (!m) { console.error("transpile_tree: bad TSAOT_DEFINE entry: " + part); process.exit(2); }
  defines.push([new RegExp("(?<![\\w$.])" + m[1].replace(/\$/g, "\\$") + "(?![\\w$])", "g"), m[2]]);
}
const bare = new Set();
// the project's options: module resolution, paths, target features; the emit settings are ours
let options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: false };
const cfgPath = path.join(root, "garnet-tsconfig.json");
if (fs.existsSync(cfgPath)) {
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  options = { ...parsed.options };
}
Object.assign(options, {
  noEmit: false, emitDeclarationOnly: false, declaration: false, declarationMap: false, sourceMap: false, inlineSourceMap: false,
  incremental: false, composite: false, tsBuildInfoFile: undefined, outDir: out, rootDir: root, module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false, isolatedModules: false, importsNotUsedAsValues: undefined,
  preserveValueImports: undefined, rewriteRelativeImportExtensions: false, noEmitOnError: false, removeComments: true,
  allowImportingTsExtensions: true, types: [], plugins: undefined,
});
if (options.module !== undefined && options.moduleResolution === undefined) options.moduleResolution = ts.ModuleResolutionKind.Bundler;
const program = ts.createProgram([path.resolve(root, entry)], options);
function resolveRel(fromFile, spec) {
  if (!spec.startsWith(".")) {   // a bare specifier of the workspace map
    const mapped = pathsMap[spec];
    return mapped ? path.resolve(root, mapped) : null;
  }
  const base = path.resolve(path.dirname(fromFile), spec);
  const stripped = base.replace(/\.(m?js|ts|tsx|mts)$/, "");
  for (const cand of [stripped + ".ts", stripped + ".tsx", stripped + ".mts", base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}
function emitted(file) { return path.join(out, path.relative(root, file)).replace(/\.(ts|tsx|mts)$/, ".mjs"); }
let count = 0;
const result = program.emit(undefined, (fileName, text) => {
  if (!fileName.endsWith(".js")) return;
  // the source this output came from: the out-relative path back under the root
  const rel = path.relative(out, fileName).replace(/\.js$/, "");
  const source = [rel + ".ts", rel + ".tsx", rel + ".mts"].map((r) => path.join(root, r)).find((f) => fs.existsSync(f));
  if (!source) return;
  let outJs = text;
  for (const [re, value] of defines) outJs = outJs.replace(re, value);
  outJs = outJs.replace(/((?:from|import)\s*\(?\s*['"])([^'"]+)(['"])/g, (m, a, spec, b) => {
    if (spec.startsWith("node:") || spec.startsWith("garnet:")) return m;
    const target = resolveRel(source, spec);
    if (target === null) { if (!spec.startsWith(".")) bare.add(spec); return m; }
    let r = path.relative(path.dirname(emitted(source)), emitted(target)).replace(/\\/g, "/");
    if (!r.startsWith(".")) r = "./" + r;
    return a + r + b;
  });
  const dst = emitted(source);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, outJs);
  count++;
});
fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}\n');
process.stdout.write(`${count} modules -> ${out}\n`);
if (result.emitSkipped) process.stdout.write("emit skipped\n");
if (bare.size) process.stdout.write(`bare specifiers left as is: ${[...bare].join(", ")}\n`);
