// the shortest digits of doubles of every kind, as one hash and the first differences by category
const buf = new ArrayBuffer(8); const f64 = new Float64Array(buf); const u32 = new Uint32Array(buf);
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; }; }
const r = rng(99);
function hashStr(h: number, s: string): number { for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h; }
function make(lo: number, hi: number): number { u32[0] = lo; u32[1] = hi; return f64[0]; }
const out: string[] = [];
function run(name: string, n: number, gen: (i: number) => number) {
  let h = 0, sample = "";
  for (let i = 0; i < n; i++) { const v = gen(i); const s = String(v); h = hashStr(h, s); if (i % (n >> 2 || 1) === 3) sample += " " + s; }
  console.log(name, h, sample);
}
run("random bits", 400000, () => make(r(), r()));
run("subnormal", 100000, () => make(r(), r() & 0xFFFFF));
run("tiny subnormal", 3000, (i) => make(i, 0));
run("powers of two", 2098, (i) => { let v = 1; const e = i - 1074; return Math.pow(2, e); });
run("powers of two near", 8000, (i) => { const e = (i % 2046) + 1; return make((i & 4) ? 1 : (i & 2) ? 0xFFFFFFFF : 0, (e << 20) | ((i & 4) ? 0 : (i & 2) ? 0xFFFFF : 0)); });
run("powers of ten", 617, (i) => Number("1e" + (i - 308)));
run("decimals", 300000, () => (r() % 100000000) / 1000);
run("money", 200000, () => (r() % 10000000) / 100);
run("ratio", 200000, () => (r() % 1000) / ((r() % 1000) + 1));
run("large", 200000, () => (r() >>> 0) * 4294967296 * ((r() % 100000) + 1));
run("near ints", 100000, () => (r() % 1000000) + 1e-9);
for (const v of [5e-324, 1.7976931348623157e308, 2.2250738585072014e-308, 2.225073858507201e-308, 1e21, 1e-7, 123456789012345680000, 0.000001, 1.5e300, 9007199254740993, 2 ** -24, 5e-1, 0.1 + 0.2, 4.35, 1 / 3]) console.log(v, -v, String(v), JSON.stringify(v), v.toString());
