#!/usr/bin/env node
// Compose test262 cases into conformance programs: harness + includes + test, one .ts each, under
// <out>/<path>.ts, for scripts/run_conformance.sh's `dir` tier (TSAOT_CONF_DIR). What cannot run in an
// ahead-of-time strict module is left out and counted by reason.
//   node scripts/test262/gen.mjs <test262 checkout> <out dir> <subpath under test/>...
import fs from "node:fs";
import path from "node:path";

const [src, out, ...subs] = process.argv.slice(2);
if (!src || !out || subs.length === 0) {
  console.error("usage: gen.mjs <test262 checkout> <out dir> <subpath>...");
  process.exit(2);
}
// features garnet does not model, or that need a host the conformance runner does not provide
const SKIP_FEATURES = new Set([
  "BigInt", "Temporal", "ShadowRealm", "decorators", "cross-realm", "IsHTMLDDA", "tail-call-optimization",
  "host-gc-required", "json-modules", "import-attributes", "source-phase-imports", "import-defer",
  "dynamic-import", "top-level-await", "Atomics", "Atomics.wait", "Atomics.waitAsync", "Atomics.pause",
  "FinalizationRegistry", "resizable-arraybuffer", "arraybuffer-transfer", "regexp-duplicate-named-groups",
]);
const skipped = new Map();
const skip = (why) => skipped.set(why, (skipped.get(why) ?? 0) + 1);
const harnessCache = new Map();
const harness = (name) => {
  if (!harnessCache.has(name)) harnessCache.set(name, fs.readFileSync(path.join(src, "harness", name), "utf8"));
  return harnessCache.get(name);
};
function listField(meta, name) {
  const inline = meta.match(new RegExp(`^${name}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (inline) return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  const block = meta.match(new RegExp(`^${name}:\\s*\\n((?:\\s+-\\s*.+\\n)+)`, "m"));
  return block ? block[1].split("\n").map((s) => s.replace(/^\s*-\s*/, "").trim()).filter(Boolean) : [];
}
function compose(file, rel) {
  const text = fs.readFileSync(file, "utf8");
  if (rel.includes("_FIXTURE")) return skip("fixture");
  const m = text.match(/\/\*---([\s\S]*?)---\*\//);
  if (!m) return skip("no metadata");
  const meta = m[1];
  if (/^negative:/m.test(meta)) return skip("negative test");
  const flags = listField(meta, "flags");
  for (const f of ["raw", "noStrict", "module", "CanBlockIsFalse", "CanBlockIsTrue"]) if (flags.includes(f)) return skip("flag " + f);
  const features = listField(meta, "features");
  for (const f of features) if (SKIP_FEATURES.has(f) || f.startsWith("Intl")) return skip("feature " + f);
  // no engine at run time, no host object
  if (/\beval\s*\(/.test(text)) return skip("eval");
  if (/\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]/.test(text)) return skip("Function constructor");
  if (/\$262\b/.test(text)) return skip("$262 host");
  const includes = listField(meta, "includes");
  if (includes.some((i) => i === "detachArrayBuffer.js" || i === "nans.js" && false)) return skip("detach host");
  const parts = ["// @ts-nocheck", "var print = console.log;", harness("assert.js"), harness("sta.js")];
  if (flags.includes("async")) parts.push(harness("doneprintHandle.js"));
  for (const i of includes) parts.push(harness(i));
  parts.push(text);
  const dst = path.join(out, rel.replace(/\.js$/, ".ts").replace(/[^A-Za-z0-9_\/.-]/g, "_"));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, parts.join("\n"));
  return true;
}
let written = 0, seen = 0;
const walk = (dir, rel) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(p, r);
    else if (e.name.endsWith(".js")) { seen++; if (compose(p, r) === true) written++; }
  }
};
for (const s of subs) {
  const base = path.join(src, "test", s);
  if (fs.statSync(base).isDirectory()) walk(base, s);
  else { seen++; if (compose(base, s) === true) written++; }
}
console.log(`[test262] ${written} programs of ${seen} cases under ${out}`);
for (const [k, v] of [...skipped].sort((a, b) => b[1] - a[1])) console.log(`  skip ${String(v).padStart(6)}  ${k}`);
