// Typed arrays across moving collections (docs/typed_arrays_design.md): a view
// keeps its buffer, hence its bytes, alive; views made from views share one
// buffer; callbacks and iterators allocate while they hold a view. Run under
// scripts/run_gc_stress.sh (young threshold 1, protect mode, ASan).
function makeView(n: number): Uint8Array {
  const buf = new ArrayBuffer(n * 4);
  const w = new Uint32Array(buf);
  for (let i = 0; i < n; i++) w[i] = 0x01010101 * (i + 1);
  return new Uint8Array(buf, 4, (n - 1) * 4);   // only the view escapes
}
function churn(): number {
  let s = 0;
  for (let i = 0; i < 50; i++) { const o = { a: [i, i + 1], b: "x" + i }; s += o.a[1]; }
  return s;
}
const views: Uint8Array[] = [];
for (let k = 0; k < 40; k++) { views.push(makeView(8 + (k % 5))); churn(); }
let total = 0;
for (const v of views) { churn(); for (let i = 0; i < v.length; i++) total += v[i]; total += v.buffer.byteLength; }
console.log(total);

// a chain of subarrays keeps the root buffer
let sub = new Int16Array(64).map((_, i) => i * 3);
for (let d = 0; d < 6; d++) { sub = sub.subarray(1, sub.length - 1); churn(); }
console.log(sub.length, sub[0], sub[sub.length - 1], sub.byteOffset);

// views held by maps and objects
const m = new Map<string, Float64Array>();
for (let k = 0; k < 30; k++) { m.set("k" + k, Float64Array.from([k, k / 2, -k])); churn(); }
let fs = 0;
for (const [, v] of m) fs += v[0] + v[1] + v[2];
console.log(fs, m.get("k7")!.join());
const holder = { t: new Int32Array([5, 6, 7]) };
churn();
holder.t[1] += 10;
console.log(holder.t.join(), holder.t.slice(1).join());

// a second view of a dropped view's buffer
let keep: Uint16Array | undefined;
{ const a = new Uint8Array(16); for (let i = 0; i < 16; i++) a[i] = i; keep = new Uint16Array(a.buffer, 2, 3); }
churn();
console.log(keep.join());

// callbacks and iterators that allocate while they hold a view
const src = new Int32Array([1, 2, 3, 4, 5, 6]);
const mapped = src.map((x) => { churn(); return x * x; });
const kept = src.filter((x) => { const o = { x }; return o.x % 2 === 0; });
const sorted = new Float64Array([3, 1, 2]).sort((x, y) => { churn(); return x - y; });
console.log(mapped.join(), kept.join(), sorted.join(), src.reduce((p, x) => { churn(); return p + x; }, 0));
const it = new Uint8Array([9, 8, 7]).values();
churn();
console.log([...it].join(), [...new Int8Array([1, -1]).entries()].join("/"));
console.log(Array.prototype.map.call(new Uint8Array([1, 2]), (x: number) => { churn(); return "v" + x; }).join());
const copies = Array.from({ length: 20 }, (_, i) => new Uint8Array(new Uint16Array([i, i + 256]).buffer).join("."));
console.log(copies[3], copies[19]);
