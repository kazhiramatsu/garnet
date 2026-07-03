// Compare two devirted Program JSONs (Rust `tsaot <ir> devirt` vs TS
// `main.js <ir> devirt`) by their CALL-SITE CALLEES — the only thing run_devirt
// rewrites. Walks every function body in instruction order (recursing nested
// bodies identically on both sides) and serializes each Call/CallSpread callee.
// Exit 0 = identical, 1 = first difference printed.
const fs = require("fs");

function callees(prog) {
  const out = [];
  const walk = (b, path) => {
    b.forEach((i, idx) => {
      if ((i.kind === "Call" || i.kind === "CallSpread") && i.callee) {
        const c = i.callee;
        let s = c.kind;
        if (c.kind === "Direct") s += `:${c.func}`;
        else if (c.kind === "Set") s += `:${(c.funcs ?? []).join("+")}`;
        else if (c.kind === "Method") s += `:${c.recvClass}.${c.method}/${c.recvStable ? "s" : "u"}`;
        else if (c.kind === "Value") s += `:${c.local}`;
        out.push(`${path}[${idx}] ${s}`);
      }
      for (const k of Object.keys(i)) {
        const v = i[k];
        if (Array.isArray(v) && v.length && v[0] && v[0].kind) walk(v, `${path}[${idx}].${k}`);
      }
    });
  };
  for (const f of prog.functions) walk(f.body, `fn${f.id}`);
  return out;
}

const a = callees(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
const b = callees(JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
if (a.length !== b.length) {
  console.log(`COUNT DIFF: ${a.length} vs ${b.length}`);
  process.exit(1);
}
for (let i = 0; i < a.length; i++) {
  if (a[i] !== b[i]) {
    console.log(`DIFF at ${i}:\n  rust: ${a[i]}\n  ts:   ${b[i]}`);
    process.exit(1);
  }
}
process.exit(0);
