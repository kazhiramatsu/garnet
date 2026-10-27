// The Node side of a real-project benchmark (benchmarks/real/run.sh): the TypeScript sources of a tree
// transpiled to ES modules with the repo's TypeScript (no type check, no bundler), the relative
// import specifiers rewritten to the emitted files (`./x` -> `./x.mjs`, `./x.js` -> `./x.mjs`,
// `./dir` -> `./dir/index.mjs`), so Node runs the same source garnet compiles.
//   node transpile_tree.js <source root> <out root> <entry.ts relative to root> [paths.json]
// Only the files reachable from the entry are emitted (the import graph through relative specifiers
// and, with paths.json, a map of bare specifiers to source files, the tsconfig's `paths` of a
// workspace; other bare specifiers are left as is and reported).
const ts = require(process.env.ROOT + "/exporter/node_modules/typescript");
const fs = require("fs"), path = require("path");
const [root, out, entry] = process.argv.slice(2, 5).map((p, i) => (i < 2 ? path.resolve(p) : p));
const pathsMap = process.argv[5] ? JSON.parse(fs.readFileSync(process.argv[5], "utf8")) : {};
const seen = new Set(), bare = new Set();
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
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, verbatimModuleSyntax: false, importsNotUsedAsValues: 0 }, fileName: file }).outputText;
  // rewrite the specifiers of the emitted module: every relative one that resolves in the source tree
  const outJs = js.replace(/((?:from|import)\s*\(?\s*['"])([^'"]+)(['"])/g, (m, a, spec, b) => {
    if (spec.startsWith("node:") || spec.startsWith("garnet:")) return m;
    const target = resolveRel(file, spec);
    if (target === null) return m;
    visit(target);
    let rel = path.relative(path.dirname(emitted(file)), emitted(target)).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    return a + rel + b;
  });
  for (const m of js.matchAll(/(?:from|import)\s*\(?\s*['"]([^'".][^'"]*)['"]/g)) if (!pathsMap[m[1]] && !m[1].startsWith("node:")) bare.add(m[1]);
  const dst = emitted(file);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, outJs);
  void sf;
}
visit(path.resolve(root, entry));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}\n');
process.stdout.write(`${seen.size} modules -> ${out}\n`);
if (bare.size) process.stdout.write(`bare specifiers left as is: ${[...bare].join(", ")}\n`);
