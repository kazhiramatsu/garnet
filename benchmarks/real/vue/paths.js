// The workspace map of vue core's clone (benchmarks/real/run.sh vue): every package under packages/ with a
// src/index.ts by its package name (`@vue/shared` -> packages/shared/src/index.ts), plus the stand-ins for
// the compiler's third-party modules (benchmarks/real/vue/stubs, copied into the clone as garnet-stubs/),
// written as the tsconfig `paths` of the garnet compile and as the transpiler's paths.json for Node.
//   node paths.js <clone root> <out tsconfig.json> <out paths.json>
const fs = require("fs"), path = require("path");
const [root, outTsconfig, outPaths] = process.argv.slice(2).map((p) => path.resolve(p));
const tsPaths = {}, nodePaths = {};
for (const dir of fs.readdirSync(path.join(root, "packages"))) {
  const pj = path.join(root, "packages", dir, "package.json");
  const index = path.join("packages", dir, "src", "index.ts");
  if (!fs.existsSync(pj) || !fs.existsSync(path.join(root, index))) continue;
  const name = JSON.parse(fs.readFileSync(pj, "utf8")).name;
  tsPaths[name] = [index];
  nodePaths[name] = index;
}
// the browser configuration of the compiler never calls these (babel parses expressions only when
// identifiers are prefixed, entities decodes them only outside a browser); the stubs throw if it does
const stubs = {
  "@babel/parser": "babel-parser.ts", "@babel/types": "babel-types.ts", "entities/decode": "entities-decode.ts",
  "estree-walker": "estree-walker.ts", "source-map-js": "source-map-js.ts",
};
for (const [spec, file] of Object.entries(stubs)) {
  tsPaths[spec] = ["garnet-stubs/" + file];
  nodePaths[spec] = "garnet-stubs/" + file;
}
const tsconfig = {
  extends: "./tsconfig.json",
  compilerOptions: {
    noEmit: true, composite: false, incremental: false, declaration: false, isolatedDeclarations: false,
    noUnusedLocals: false, noUnusedParameters: false, types: [], lib: ["es2022", "dom"],
    baseUrl: ".", paths: tsPaths,
  },
  include: [],
  // the build-time flags are ambient declarations (garnet-stubs/globals.d.ts); garnet-stubs/globals.ts,
  // the driver's first import, gives them their values on the global object before any vue module runs
  files: ["garnet-driver.ts", "garnet-stubs/globals.d.ts"],
};
fs.writeFileSync(outTsconfig, JSON.stringify(tsconfig, null, 2) + "\n");
fs.writeFileSync(outPaths, JSON.stringify(nodePaths, null, 2) + "\n");
