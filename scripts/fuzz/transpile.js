// x.ts to x.mjs, the module format and target of the oracle (docs/agent_workflow.md, section 2.1).
const path = require("path"), fs = require("fs");
const ts = require(path.join(__dirname, "../../exporter/node_modules/typescript"));
for (const f of process.argv.slice(2)) {
  const out = ts.transpileModule(fs.readFileSync(f, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  fs.writeFileSync(f.replace(/\.ts$/, ".mjs"), out);
}
