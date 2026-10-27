// The workspace map of prisma's clone (benchmarks/real/run.sh prisma): every internal package's name and
// `exports` subpaths mapped to its TypeScript sources (`./dist/x.mjs` -> `src/exports/x.ts` or `src/x.ts`),
// written as the tsconfig `paths` of the garnet compile and as the transpiler's paths.json for Node.
//   node paths.js <clone root> <out tsconfig.json> <out paths.json>
const fs = require("fs"), path = require("path");
const [root, outTsconfig, outPaths] = process.argv.slice(2).map((p) => path.resolve(p));
const tsPaths = {}, nodePaths = {};
function walk(dir, depth) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === "node_modules") continue;
    const sub = path.join(dir, e.name);
    const pj = path.join(sub, "package.json");
    if (fs.existsSync(pj)) {
      const p = JSON.parse(fs.readFileSync(pj, "utf8"));
      if (p.name && p.exports) {
        for (const [key, target] of Object.entries(p.exports)) {
          if (key === "./package.json") continue;
          const t = typeof target === "string" ? target : target && (target.import || target.default);
          if (!t) continue;
          const base = path.basename(t).replace(/\.m?js$/, "");
          const cand = [`src/exports/${base}.ts`, `src/${base}.ts`, `src/exports/${base}/index.ts`, `src/${base}/index.ts`].map((c) => path.join(sub, c)).find((c) => fs.existsSync(c));
          if (!cand) continue;
          const spec = key === "." ? p.name : p.name + key.slice(1);
          tsPaths[spec] = [path.relative(root, cand)];
          nodePaths[spec] = path.relative(root, cand);
        }
      }
    }
    if (depth < 4) walk(sub, depth + 1);
  }
}
walk(path.join(root, "packages"), 0);
const tsconfig = {
  extends: "./packages/0-config/tsconfig/base.json",
  compilerOptions: {
    noEmit: true, types: [], declaration: false, declarationMap: false, sourceMap: false,
    noUnusedLocals: false, noUnusedParameters: false,
    // the project's index-access and index-signature strictness is a style choice of its own code; garnet's library files predate it
    noUncheckedIndexedAccess: false, noPropertyAccessFromIndexSignature: false,
    baseUrl: ".", paths: tsPaths,
  },
  files: ["garnet-driver.ts"],
};
fs.writeFileSync(outTsconfig, JSON.stringify(tsconfig, null, 2) + "\n");
fs.writeFileSync(outPaths, JSON.stringify(nodePaths, null, 1) + "\n");
console.log(`${Object.keys(tsPaths).length} specifiers mapped`);
