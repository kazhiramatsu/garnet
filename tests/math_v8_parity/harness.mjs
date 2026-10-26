// The V8 side of tests/math_v8_parity (see harness.c).
let st = 0;
function u32() { st = (st + 0x6D2B79F5) | 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (t ^ (t >>> 14)) >>> 0; }
function unit() { return u32() / 4294967296; }
const scales = [1e-6, 1e-3, 1.0, 10.0, 100.0, 1000.0, 1e6, 1e15];
const twoPow = []; { let p = 1.0; for (let i = 0; i < 50; i++) p /= 2; for (let e = 0; e < 1100; e++) { twoPow.push(p); p *= 2; } }
function gen(g) {
  switch (g) {
    case 0: { const s = u32() % 8; return (unit() * 2 - 1) * scales[s]; }
    case 1: return unit() * 2 - 1;
    case 2: { const s = u32() % 8; return unit() * scales[s]; }
    case 3: { const s = u32() % 8; return 1 + unit() * scales[s]; }
    case 4: { const e = u32() % 1100; const m = unit() * 2 - 1; return m * twoPow[e]; }
    default: return unit() * 2.2250738585072014e-308;
  }
}
const f64 = new Float64Array(1), w = new Uint32Array(f64.buffer);
let h = 0;
function feed(y) { f64[0] = y; let lo = w[0], hi = w[1]; if (y !== y) { hi = 0x7FF80000; lo = 0; } h = (Math.imul(h, 31) + hi) | 0; h = (Math.imul(h, 31) + lo) | 0; }
const out = [];
function run1(name, f, g, idx) { st = (1234 + Math.imul(7919, idx)) | 0; h = 0; for (let i = 0; i < 100000; i++) feed(f(gen(g))); out.push(`${name}/${g} ${h}`); }
function run2(name, f, ga, gb, idx, powy) {
  st = (1234 + Math.imul(7919, idx)) | 0; h = 0;
  for (let i = 0; i < 100000; i++) {
    const x = gen(ga); let y;
    if (powy) { const k = u32() % 3; if (k === 0) y = (u32() % 41) - 20; else if (k === 1) y = (u32() & 1) ? 0.5 : -0.5; else y = (unit() * 2 - 1) * 10; }
    else y = gen(gb);
    feed(f(x, y));
  }
  out.push(`${name}/${ga}${gb} ${h}`);
}
function hex(y) { f64[0] = y; let lo = w[0], hi = w[1]; if (y !== y) { hi = 0x7FF80000; lo = 0; } return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0"); }
function edge1(name, f, E) { for (let i = 0; i < E.length; i++) out.push(`${name}[${i}] ${hex(f(E[i]))}`); }
function edge2(name, f, E) { for (let i = 0; i < E.length; i++) for (let j = 0; j < E.length; j++) out.push(`${name}[${i},${j}] ${hex(f(E[i], E[j]))}`); }
const E = [0.0, -0.0, 1.0, -1.0, Infinity, -Infinity, NaN, 2.2250738585072014e-308, 5e-324, 1.7976931348623157e308, 0.9999999999999999, 1.0000000000000002, 709.782712893384, -745.1332191019411, 0.5, 2.0, 10.0, 1e-300, 3.141592653589793, 1.5707963267948966, 1e22, 1152921504606846976.0, -1152921504606846976.0, 1e308, -0.5, 3.0, 0.1, -2.5];
const F = [["exp", Math.exp], ["expm1", Math.expm1], ["log", Math.log], ["log1p", Math.log1p], ["log2", Math.log2], ["log10", Math.log10], ["sin", Math.sin], ["cos", Math.cos], ["tan", Math.tan], ["asin", Math.asin], ["acos", Math.acos], ["atan", Math.atan], ["sinh", Math.sinh], ["cosh", Math.cosh], ["tanh", Math.tanh], ["asinh", Math.asinh], ["acosh", Math.acosh], ["atanh", Math.atanh], ["cbrt", Math.cbrt]];
if (process.argv.length === 5) {
  const nm = process.argv[3], g = +process.argv[4]; const k = F.findIndex((e) => e[0] === nm);
  st = (1234 + Math.imul(7919, k * 6 + g)) | 0; const f = F[k][1];
  const u64 = new BigUint64Array(f64.buffer);
  for (let i = 0; i < 100000; i++) { const x = gen(g); const y = f(x); f64[0] = x; const bx = u64[0].toString(16).padStart(16, "0"); f64[0] = y; let by = u64[0].toString(16).padStart(16, "0"); if (y !== y) by = "7ff8000000000000"; out.push(`${i} ${bx} ${by}`); }
  console.log(out.join("\n")); process.exit(0);
}
let idx = 0;
for (const [n, f] of F) for (let g = 0; g < 6; g++) run1(n, f, g, idx++);
run2("atan2", Math.atan2, 0, 0, idx++, 0); run2("atan2", Math.atan2, 4, 0, idx++, 0); run2("atan2", Math.atan2, 5, 5, idx++, 0);
run2("pow", Math.pow, 0, 9, idx++, 1); run2("pow", Math.pow, 4, 9, idx++, 1); run2("pow", Math.pow, 2, 9, idx++, 1);
for (const [n, f] of F) edge1(n, f, E);
edge2("atan2", Math.atan2, E); edge2("pow", Math.pow, E);
console.log(out.join("\n"));
