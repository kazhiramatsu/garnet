#!/usr/bin/env node
// Compose test262 cases into conformance programs: harness + includes + test, one .ts each, under
// <out>/<path>.ts, for scripts/run_conformance.sh's `dir` tier (TSAOT_CONF_DIR). Every case is written,
// whatever it needs: what garnet cannot do shows in the results. <out>/META.tsv records each case's
// flags, its negative expectation, its features and whether it needs an engine at run time, for
// scripts/test262/summary.py.
//   node scripts/test262/gen.mjs <test262 checkout> <out dir> <subpath under test/>...
import fs from "node:fs";
import path from "node:path";

const [src, out, ...subs] = process.argv.slice(2);
if (!src || !out || subs.length === 0) {
  console.error("usage: gen.mjs <test262 checkout> <out dir> <subpath>...");
  process.exit(2);
}
const harnessCache = new Map();
const harness = (name) => {
  if (!harnessCache.has(name)) {
    let text = fs.readFileSync(path.join(src, "harness", name), "utf8");
    // the subclasses are built from strings "without bombing out when `class` isn't supported": a compiled
    // program writes them out
    if (name === "resizableArrayBufferUtils.js") {
      text = text.replace(/function subClass\(type\) \{[\s\S]*?\n\}\n/, "")
        .replace(/const (My\w+) = subClass\('(\w+)'\);/g, "const $1 = class $1 extends $2 {};");
    }
    harnessCache.set(name, text);
  }
  return harnessCache.get(name);
};
function listField(meta, name) {
  const inline = meta.match(new RegExp(`^${name}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (inline) return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  const block = meta.match(new RegExp(`^${name}:\\s*\\n((?:\\s+-\\s*.+\\n)+)`, "m"));
  return block ? block[1].split("\n").map((s) => s.replace(/^\s*-\s*/, "").trim()).filter(Boolean) : [];
}
const dstOf = (rel) => path.join(out, rel.replace(/\.js$/, ".ts").replace(/[^A-Za-z0-9_\/.-]/g, "_"));
const slugOf = (rel) => rel.replace(/\.js$/, "").replace(/[^A-Za-z0-9_\/.-]/g, "_").replaceAll("/", "__");
const meta = [];
// The case builds code from a string at run time, which a compiled program has no engine for.
const usesRuntimeCode = (body) => /\beval\s*\(|\(\s*0\s*,\s*eval\s*\)|\bnew\s+\w*Function\s*\(|(^|[^.\w])(\w*Function)\s*\(\s*['"`]/m.test(body);
function compose(file, rel) {
  const text = fs.readFileSync(file, "utf8");
  const dst = dstOf(rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // a module's dependency: beside it, not a case (the `dir` tier passes over *_FIXTURE*)
  if (rel.includes("_FIXTURE")) { fs.writeFileSync(dst, "// @ts-nocheck\n" + text); return; }
  const m = text.match(/\/\*---([\s\S]*?)---\*\//);
  const front = m ? m[1] : "";
  const flags = listField(front, "flags");
  const includes = listField(front, "includes");
  const neg = front.match(/^negative:\s*\n((?:\s+.+\n)+)/m);
  const phase = neg ? (neg[1].match(/phase:\s*(\S+)/)?.[1] ?? "") : "";
  const type = neg ? (neg[1].match(/type:\s*(\S+)/)?.[1] ?? "") : "";
  // A case that must be refused before it runs is compiled as a TypeScript file is: alone, with the
  // checker on, whose syntax and early errors are what a real program would meet.
  if (phase === "parse" || phase === "early") {
    fs.writeFileSync(dst, "declare function $DONOTEVALUATE(): never;\n" + text);
    meta.push([slugOf(rel), flags.join(","), phase, type, listField(front, "features").join(",")].join("\t"));
    return;
  }
  const parts = ["// @ts-nocheck"];
  if (!flags.includes("raw")) {
    parts.push("var print = console.log;", harness("assert.js"), harness("sta.js"));
    if (flags.includes("async")) parts.push(harness("doneprintHandle.js"));
    for (const i of includes) parts.push(harness(i));
  }
  parts.push(text);
  fs.writeFileSync(dst, parts.join("\n"));
  meta.push([slugOf(rel), flags.join(","), phase, type, listField(front, "features").join(","), usesRuntimeCode(text.replace(m?.[0] ?? "", "")) ? "eval" : ""].join("\t"));
}
const walk = (dir, rel) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(p, r);
    else if (e.name.endsWith(".js")) compose(p, r);
  }
};
const fixturesDone = new Set();
for (const s of subs) {
  const base = path.join(src, "test", s);
  if (fs.statSync(base).isDirectory()) { walk(base, s); continue; }
  compose(base, s);
  // a case given by its path: the module fixtures beside it
  const dir = path.dirname(s);
  if (fixturesDone.has(dir)) continue;
  fixturesDone.add(dir);
  for (const e of fs.readdirSync(path.dirname(base), { withFileTypes: true })) {
    if (e.isFile() && e.name.includes("_FIXTURE") && e.name.endsWith(".js")) compose(path.join(path.dirname(base), e.name), dir + "/" + e.name);
  }
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "META.tsv"), meta.join("\n") + "\n");
console.log(`[test262] ${meta.length} cases under ${out}`);
