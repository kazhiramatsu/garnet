// Integer locals stored as int32 (docs/int32_codegen_design.md, "int32 locals"): a local whose
// range lies within int32 holds its exact value; a wrap-safe local (every use a bitwise operand
// or an operand of + - * whose result is narrow, every definition arithmetic or bitwise) holds the
// value modulo 2^32, which is all its consumers can see. Every printed value must agree with V8:
// sums and products that overflow int32 on the way to a `| 0`, the same chains observed exactly
// (printed, compared, divided, stored, returned) which must stay wide, hashes, the int32 limits,
// negation of the minimum, remainders of negatives, and copies between narrow and wide locals.
function hashChain(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i) & 0xffff; h = ((h ^ c) * 16777619) | 0; }
  return h;
}
function sumOverflowWrapped(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) acc = (acc + 1000000007) | 0;   // wraps as int32 each step
  return acc;
}
function sumOverflowExact(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) acc = acc + 1000000007;          // exact: observed as a number
  return acc;
}
function productsNearLimit(a: number, b: number): string {
  const x = a | 0, y = b | 0;
  const w = (x * y) | 0;                   // the low 32 bits of an exact product below 2^53 (the inputs are bounded below)
  const e = x * y;                         // exact
  return [w, e, (x + y) | 0, x + y, (x - y) | 0, x - y].join(",");
}
function smallProducts(q: Int8Array, r: Int8Array): string {
  let w = 0, cnt = 0, mx = -1e9;
  for (let i = 0; i < q.length; i++) {
    const a = (q[i] << 24) >> 24, b = (r[i] << 24) >> 24;
    const p = a * b;                       // within int32: exact, compared and summed
    w = (w + p) | 0;
    if (p > mx) mx = p;
    if (p < 0) cnt++;
  }
  return [w, mx, cnt].join(",");
}
function negMin(v: number): string {
  const m = v | 0;                         // -2147483648 at the limit
  const n = -m;                            // 2147483648: does not fit, stays exact
  const back = (n | 0);
  return [m, n, back, n === 2147483648, (m - 1) | 0, m - 1, (m * 2) | 0, m * 2].join(",");
}
function remainders(a: number, b: number): string {
  const x = a | 0, y = b | 0;
  return [x % y, (x % y) | 0, x % 7, (-x) % 7, x % -1, (x | 0) % (y | 1)].join(",");
}
function copies(a: number): string {
  const n = a | 0;                         // narrow
  let wide = n;                            // a copy observed exactly
  wide = wide * 3000000000;                // beyond int32, exact
  const again = (wide | 0);
  return [n, wide, again, wide > 1e12, Number.isSafeInteger(wide)].join(",");
}
function mixed(k: number): number {
  // a narrow local used as an array index and a loop bound (exact uses)
  const n = k & 15;
  const arr = new Float64Array(16);
  for (let i = 0; i < n; i++) arr[i] = i * 1.5;
  let s = 0;
  for (let i = 0; i < n; i++) s += arr[i];
  return s + arr[n - 1 < 0 ? 0 : n - 1];
}
function main(): void {
  console.log(hashChain("garnet"), hashChain(""), hashChain("the quick brown fox jumps over the lazy dog".repeat(20)));
  console.log(sumOverflowWrapped(10), sumOverflowWrapped(1000), sumOverflowExact(10), sumOverflowExact(1000));
  console.log(productsNearLimit(65535, 65537), productsNearLimit(-46341, 46341), productsNearLimit(2147483647, 1), productsNearLimit(-2147483648, -1), productsNearLimit(3, -7));
  console.log(smallProducts(new Int8Array([127, -128, 1, -1, 0, 100]), new Int8Array([127, 127, -1, -1, -128, -100])), smallProducts(new Int8Array(0), new Int8Array(0)));
  console.log(negMin(-2147483648), negMin(2147483647), negMin(0), negMin(-1));
  console.log(remainders(-7, 3), remainders(2147483647, -2), remainders(-2147483648, 1), remainders(13, 5), remainders(-2147483648, -1));
  console.log(copies(5), copies(-2147483648), copies(2147483647));
  console.log(mixed(0), mixed(5), mixed(31), mixed(-1));
}
main();

// The unsigned shift's result is a uint32, not an int32: a local holding `v >>> 0`, its copies
// and an accumulator folded with `>>>` are not stored as int32 (the first build of the
// int32-by-definition seed did, printing -1 for 4294967295).
function unsignedShiftLocals(): void {
  const vals = [-1, 4294967295, 2147483648, -2147483648, 0, 1e10];
  const out: number[] = [];
  for (const v of vals) {
    let u = v >>> 0;
    const w = u;
    let acc = 0;
    for (let i = 0; i < 3; i++) acc = (acc + u) >>> 0;
    const back = u | 0;
    const high = u >>> 31;
    out.push(u, w, u + 1, acc, back, high, (u >>> 0) === w ? 1 : 0);
  }
  console.log(out.join(","));
}
unsignedShiftLocals();
