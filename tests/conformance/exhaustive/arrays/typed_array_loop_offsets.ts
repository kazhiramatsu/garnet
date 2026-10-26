// Typed-array loops whose index is `i + offset` or whose bound is a double (docs/typed_array_loops_design.md):
// matrix products over flat buffers, offsets as integer and double locals and constants, offsets that
// are fractional, negative, NaN or beyond the length (the general loop's semantics: a read past the end
// is undefined, a write is dropped), fractional and NaN bounds and a bound beyond the length, float32,
// int8 and uint8 views, two views of one buffer, the loop variable after the loop, a copy of the index,
// and an index defined twice in the body (not taken, the same result).
function matmul(a: Float64Array, b: Float64Array, o: Float64Array, m: number, k: number, n: number): void {
  for (let i = 0; i < m; i++) {
    const ro = i * n;
    for (let p = 0; p < k; p++) {
      const aip = a[i * k + p], rb = p * n;
      for (let j = 0; j < n; j++) o[ro + j] += aip * b[rb + j];
    }
  }
}
function matmul32(a: Float32Array, b: Float32Array, o: Float32Array, m: number, k: number, n: number): void {
  for (let i = 0; i < m; i++) {
    const ro = i * n;
    for (let p = 0; p < k; p++) {
      const aip = a[i * k + p], rb = p * n;
      for (let j = 0; j < n; j++) o[ro + j] += aip * b[rb + j];
    }
  }
}
function shifted(a: Float64Array, off: number, n: number): number {
  let s = 0;
  for (let j = 0; j < n; j++) s += a[off + j];
  return s;
}
function shiftedInt(a: Float64Array, off: number, n: number): number {
  const o = off | 0;
  let s = 0;
  for (let j = 0; j < n; j++) s += a[j + o] * 2;
  return s;
}
function storeShifted(a: Int8Array, off: number, n: number): void {
  for (let j = 0; j < n; j++) a[j + off] = j * 37 - 100;
}
function constOffsets(a: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i + 2] * 3 - a[i + 1] + a[i];
  return s;
}
function twoViews(buf: ArrayBuffer): string {
  const a = new Float32Array(buf), b = new Float32Array(buf, 8);
  for (let i = 0; i < 4; i++) b[i + 1] = a[i] * 2 + 0.25;
  return a.join(",") + "|" + b.join(",");
}
function definedTwice(a: Float64Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    let t = i + 1;
    s += a[t];
    t = i + 2;
    s += a[t] * 10;
  }
  return s;
}
function copiedIndex(a: Float64Array, off: number, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const t = off + i;
    const u = t;
    s += a[u] * a[t];
  }
  return s;
}
function afterLoop(a: Float64Array, off: number, n: number): string {
  let i = 0;
  let s = 0;
  for (i = 0; i < n; i++) s += a[i + off];
  return i + ":" + s;
}
function boundOnly(a: Float64Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  return s;
}
function sumSq(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return s;
}
function main(): void {
  const a = new Float64Array(6), b = new Float64Array(6), o = new Float64Array(4);
  for (let i = 0; i < 6; i++) { a[i] = i + 1; b[i] = (i % 3) - 1 + 0.5 * i; }
  matmul(a, b, o, 2, 3, 2);
  console.log(o.join(","));
  const a32 = new Float32Array([1.5, -2.25, 3, 0.1, 0.2, 0.3]), b32 = new Float32Array([2, 0.5, -1, 1e-3, 7, 0]), o32 = new Float32Array(4);
  matmul32(a32, b32, o32, 2, 3, 2);
  console.log(o32.join(","));
  const big = new Float64Array(64 * 64), big2 = new Float64Array(64 * 64), big3 = new Float64Array(64 * 64);
  for (let i = 0; i < big.length; i++) { big[i] = Math.sin(i) * 0.5; big2[i] = Math.cos(i * 0.1); }
  matmul(big, big2, big3, 64, 64, 64);
  console.log(sumSq(big3), big3[0], big3[64 * 64 - 1]);
  // offsets: integers in range, beyond the end (undefined -> NaN), negative, fractional, NaN, huge
  const v = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]);
  console.log(shifted(v, 0, 8), shifted(v, 3, 5), shifted(v, 3, 6), shifted(v, -1, 3), shifted(v, 2.5, 3), shifted(v, NaN, 2), shifted(v, 1e12, 2), shifted(v, 8, 0), shifted(v, 7, 1));
  console.log(shiftedInt(v, 2, 3), shiftedInt(v, -1, 2), shiftedInt(v, 6, 4), shiftedInt(v, 4.9, 2));
  // stores beyond the end are dropped, int8 wraps
  const i8 = new Int8Array(6);
  storeShifted(i8, 2, 10); console.log(i8.join(","));
  storeShifted(i8, -1, 3); console.log(i8.join(","));
  storeShifted(i8, 0.5, 3); console.log(i8.join(","));
  storeShifted(i8, 1, 3); console.log(i8.join(","));
  const u8 = new Uint8Array([10, 20, 30, 40, 250]);
  console.log(constOffsets(u8), constOffsets(new Uint8Array(0)), constOffsets(new Uint8Array([7])));
  const buf = new ArrayBuffer(32);
  new Float32Array(buf).set([1, 2, 3, 4, 5, 6, 7, 8]);
  console.log(twoViews(buf));
  console.log(definedTwice(v, 6), definedTwice(v, 8), copiedIndex(v, 1, 3), copiedIndex(v, 6, 4), copiedIndex(v, -2, 2));
  console.log(afterLoop(v, 2, 3), afterLoop(v, 2, 9), afterLoop(v, 2.5, 2), afterLoop(v, 0, 0), afterLoop(v, 0, -3));
  // bounds: a fractional, a NaN, a negative, past the length, exactly the length
  console.log(boundOnly(v, 2.5), boundOnly(v, NaN), boundOnly(v, -1), boundOnly(v, 10), boundOnly(v, 8), boundOnly(v, 0.5), boundOnly(v, 1e-9));
}
main();
