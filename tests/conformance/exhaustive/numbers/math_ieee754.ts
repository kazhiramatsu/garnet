// Math's transcendental functions are V8's own implementations (runtime/ts_ieee754.c, a C
// translation of V8's fdlibm port), so every result agrees with Node to the last bit: hashes of
// the result bit patterns over pseudo-random inputs in several ranges (typed direct calls,
// first-class Math functions, calls through any, the ** operator) and the special values of pow,
// atan2 and the correctly-rounded cases a platform libm gets wrong (cbrt(27), log2(8)).
class Rng {
  private state: number;
  constructor(seed: number) { this.state = seed | 0; }
  next(): number {
    this.state = (this.state + 0x6D2B79F5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
const f64 = new Float64Array(1);
const w32 = new Uint32Array(f64.buffer);
function fold(h: number, y: number): number {
  f64[0] = y;
  let lo = w32[0], hi = w32[1];
  if (y !== y) { hi = 0x7FF80000; lo = 0; }
  h = (Math.imul(h, 31) + hi) | 0;
  return (Math.imul(h, 31) + lo) | 0;
}
function bits(y: number): string {
  f64[0] = y;
  let lo = w32[0], hi = w32[1];
  if (y !== y) { hi = 0x7FF80000; lo = 0; }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}
// first-class functions: the generic adapters
function hashFn(name: string, f: (x: number) => number, scales: number[], n: number): string {
  const rng = new Rng(name.length * 7919 + 17);
  let h = 0;
  for (const scale of scales) for (let i = 0; i < n; i++) h = fold(h, f((rng.next() * 2 - 1) * scale));
  return name + ":" + h;
}
function hashFn2(name: string, f: (a: number, b: number) => number, scale: number, n: number): string {
  const rng = new Rng(name.length * 104729 + 3);
  let h = 0;
  for (let i = 0; i < n; i++) {
    const x = (rng.next() * 2 - 1) * scale;
    const k = (rng.next() * 3) | 0;
    const y = k === 0 ? ((rng.next() * 41) | 0) - 20 : k === 1 ? (rng.next() < 0.5 ? 0.5 : -0.5) : (rng.next() * 2 - 1) * 10;
    h = fold(h, f(x, y));
  }
  return name + ":" + h;
}
// typed direct calls: the inline numeric path
function hashDirect(n: number): string {
  const rng = new Rng(4242);
  let he = 0, hl = 0, hs = 0, hc = 0, ht = 0, hp = 0, ha = 0, hq = 0, hx = 0;
  for (let i = 0; i < n; i++) {
    const x = (rng.next() * 2 - 1) * 30;
    const y = (rng.next() * 2 - 1) * 4;
    he = fold(he, Math.exp(x));
    hl = fold(hl, Math.log(Math.abs(x) + 1e-9));
    hs = fold(hs, Math.sin(x * 1e5));
    hc = fold(hc, Math.cos(x));
    ht = fold(ht, Math.tanh(x));
    hp = fold(hp, Math.pow(Math.abs(x), y));
    ha = fold(ha, Math.atan2(y, x));
    hq = fold(hq, x ** 2 + y ** 0.5 + Math.abs(x) ** y);
    hx = fold(hx, 1 / (1 + Math.exp(-x)) + Math.expm1(y) - Math.log1p(Math.abs(y)) + Math.cbrt(x) + Math.log2(Math.abs(x)) + Math.log10(Math.abs(y)));
  }
  return [he, hl, hs, hc, ht, hp, ha, hq, hx].join(",");
}
function main(): void {
  const wide = [1e-3, 1, 20, 1e6];
  const trig = [1e-3, 1, 20, 1e15, 1e300];
  const out: string[] = [];
  out.push(hashFn("exp", Math.exp, [1e-3, 1, 20, 700], 1500));
  out.push(hashFn("expm1", Math.expm1, [1e-9, 1e-3, 1, 20, 700], 1500));
  out.push(hashFn("log", Math.log, wide, 1500));
  out.push(hashFn("log1p", Math.log1p, [1e-9, 1e-3, 1, 1e6], 1500));
  out.push(hashFn("log2", Math.log2, wide, 1500));
  out.push(hashFn("log10", Math.log10, wide, 1500));
  out.push(hashFn("sin", Math.sin, trig, 1500));
  out.push(hashFn("cos", Math.cos, trig, 1500));
  out.push(hashFn("tan", Math.tan, trig, 1500));
  out.push(hashFn("asin", Math.asin, [1e-3, 1], 1500));
  out.push(hashFn("acos", Math.acos, [1e-3, 1], 1500));
  out.push(hashFn("atan", Math.atan, wide, 1500));
  out.push(hashFn("sinh", Math.sinh, [1e-3, 1, 20, 700], 1500));
  out.push(hashFn("cosh", Math.cosh, [1e-3, 1, 20, 700], 1500));
  out.push(hashFn("tanh", Math.tanh, [1e-3, 1, 20], 1500));
  out.push(hashFn("asinh", Math.asinh, wide, 1500));
  out.push(hashFn("acosh", Math.acosh, [1, 20, 1e6], 1500));
  out.push(hashFn("atanh", Math.atanh, [1e-3, 1], 1500));
  out.push(hashFn("cbrt", Math.cbrt, wide, 1500));
  out.push(hashFn2("pow", Math.pow, 20, 4000));
  out.push(hashFn2("atan2", Math.atan2, 20, 4000));
  out.push("direct:" + hashDirect(4000));
  const anyMath: any = Math;
  out.push("any:" + bits(anyMath.exp(1.5)) + "," + bits(anyMath.tanh(-0.75)) + "," + bits(anyMath.pow(1.1, 7)));
  console.log(out.join(" "));
  // the special values of pow and the ** operator
  const p: string[] = [];
  const pows: [number, number][] = [[1, Infinity], [-1, -Infinity], [1, NaN], [NaN, 0], [NaN, 1], [0, -1], [-0, -1], [-0, -2], [-0, 0.5], [-0, 3], [-Infinity, 0.5], [-Infinity, 0.3], [-Infinity, 3], [-8, 1 / 3], [2, -1074], [2, -1075], [2, 1024], [2, 1023], [-2, 3], [-2, 2], [10, -5], [10, 22], [7, 0.5], [0.1, 2], [1e-310, 2], [-0.5, 0.5], [Infinity, -1], [0.5, Infinity], [1.5, -Infinity]];
  for (const [a, b] of pows) p.push(bits(Math.pow(a, b)) + "/" + bits(a ** b));
  console.log(p.join(" "));
  console.log(2 ** 10, 3 ** -2, (-8) ** (1 / 3), 1 ** Infinity, Math.pow(2, 0.5) === Math.sqrt(2), 1.3 ** 2 === 1.3 * 1.3, (-0) ** 0.5, Object.is((-0) ** 3, -0));
  // the quadrants of atan2 with signed zeros and infinities
  const vals = [0, -0, 1, -1, Infinity, -Infinity, NaN, 2.5, -1e-300];
  const q: string[] = [];
  for (const y of vals) for (const x of vals) q.push(bits(Math.atan2(y, x)));
  console.log(q.join(" "));
  // correctly rounded cases, limits and famous values
  console.log(Math.cbrt(27), Math.cbrt(-64), Math.cbrt(1e-300), Math.cbrt(8e300), Math.log2(8), Math.log2(1073741824), Math.log10(1000), Math.log10(1e-7), Math.log2(3), Math.log10(2));
  console.log(Math.exp(709.782712893384), Math.exp(709.8), Math.exp(-745.2), Math.exp(-745.1332191019411), Math.exp(1), Math.exp(-1), Math.expm1(1e-17), Math.log1p(1e-17), Math.log1p(-1), Math.log(0), Math.log(-1), Math.log(2));
  console.log(Math.tanh(20), Math.tanh(-20), Math.tanh(1e-20), Math.sinh(710.5), Math.cosh(-710.5), Math.sinh(1e-10), Math.asinh(-1e300), Math.acosh(1), Math.atanh(1), Math.atanh(-1), Math.atanh(0.5));
  console.log(Math.sin(1e22), Math.cos(1e22), Math.tan(1e22), Math.sin(Math.PI), Math.cos(Math.PI / 2), Math.tan(Math.PI / 4), Math.sin(1e300), Math.cos(-1e300), Math.sin(5e-324), Math.asin(1), Math.acos(-1), Math.atan(Infinity), Math.atan(-1e-320));
  console.log(bits(Math.asinh(-0)), bits(Math.sin(-0)), bits(Math.tanh(-0)), bits(Math.cbrt(-0)), bits(Math.atan(-0)), bits(Math.expm1(-0)), bits(Math.log1p(-0)), bits(Math.atanh(-0)));
  const m = [1, 4, 9].map(Math.log).map(Math.exp).map(Math.cbrt);
  console.log(m.join(","), [0.5, -0.5].map(Math.asin).join(","), [1, 2].map(Math.sinh).map(Math.asinh).join(","));
}
main();
