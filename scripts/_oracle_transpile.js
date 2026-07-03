// Transpile a .ts to an ESM .mjs (strip types) for the node reference oracle —
// same mechanism as scripts/difftest.sh (ts.transpileModule, ESNext module).
const ts = require("typescript");
const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
fs.writeFileSync(process.argv[3], js);
