// Normalized deep-compare of two Program-IR JSON dumps (Rust serde vs the TS
// analyzer's passthrough). Differences that are pure SERIALIZATION (key order,
// `field: null` vs absent — serde always emits Option fields, the TS side
// passes the exporter's objects through) are erased by normalization:
// recursively drop null-valued keys and sort object keys. Everything else
// (instruction sequences, ids, values) must match exactly.
// Usage: node _ir_norm_diff.cjs a.json b.json   -> exit 0 identical, 1 + first
// diff path printed otherwise.
const fs = require("fs");

function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const out = {};
    // ConstVal Num: the exporter may emit the value as a STRING (precision-
    // preserving); Rust's de_f64_lenient parses it and re-serializes a number.
    // Compare numerically.
    if (v.kind === "Num" && typeof v.value === "string") {
      v = { ...v, value: Number(v.value) };
    }
    for (const k of Object.keys(v).sort()) {
      const x = v[k];
      // serde always emits Option (null), Vec (possibly []) and bool (false)
      // defaults; the TS side passes the exporter's objects through, which
      // omit them. All consumers treat absent as null/[]/false (`?? []` etc.),
      // so dropping these is semantics-preserving; a REAL true-vs-false or
      // list-content difference still surfaces as a key/content mismatch.
      if (x === null || x === false) continue;
      if (Array.isArray(x) && x.length === 0) continue;
      // numeric serde(default) fields the exporter omits when 0
      if (x === 0 && (k === "arity" || k === "up")) continue;
      out[k] = norm(x);
    }
    return out;
  }
  return v;
}

function firstDiff(a, b, path) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join(",") !== kb.join(",")) return `${path} keys [${ka}] != [${kb}]`;
    for (const k of ka) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  if (a !== b) return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  return null;
}

const a = norm(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
const b = norm(JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
const d = firstDiff(a, b, "$");
if (d) {
  console.log(d);
  process.exit(1);
}
process.exit(0);
