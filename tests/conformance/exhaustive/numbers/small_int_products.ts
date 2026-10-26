// Products in the integer analysis (docs/int32_codegen_design.md, "Bounded bitwise results"): a
// bitwise operator that bounds its result (`& mask`, `>> k`, `>>> k`, `x | 0` of a bounded x) gives
// the numeric analysis a range, and a product of two bounded values that fits 2^53 stays an integer;
// a product that may be -0 (a zero times a negative) stays an integer only where every use absorbs
// the sign (`+`/`-` with an int32-by-definition value or an integer constant, a bitwise operand,
// a comparison). Every printed value must agree with V8: the absorbed cases, the observable -0
// (printed, stored, returned, copied), hashes with int32 factors, and products past 2^53.
function dotInt8(q: Int8Array, qOff: number, x: Int8Array, xOff: number, n: number): number {
  let isum = 0;
  for (let j = 0; j < n; j++) {
    const a = (q[qOff + j] << 24) >> 24, b = (x[xOff + j] << 24) >> 24;   // the int8 range, by the shifts
    isum = (isum + a * b) | 0;
  }
  return isum;
}
function dotUint8(q: Uint8Array, x: Uint8Array, n: number): number {
  let s = 0;
  for (let j = 0; j < n; j++) s = (s + (q[j] & 255) * (x[j] & 255)) | 0;
  return s;
}
function hash31(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;   // h int32 times 31: within 2^53
  return h;
}
function fnv(bytes: Uint8Array): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function nibbles(byte: number, lo: number, hi: number): number {
  return ((byte & 15) - 8) * lo + ((byte >> 4) - 8) * hi;   // bounded by the mask and the shift
}
function negativeZeroObserved(z: number, m: number): string {
  const p = (z & 0) * m;                 // 0 * negative is -0 in JS
  const copy = p;
  const arr = [p];
  return [Object.is(p, -0), 1 / p, String(p), Object.is(copy, -0), Object.is(arr[0], -0), p + 0, Object.is(p + 0, -0), Object.is(p - 0, -0), p | 0, p < 0, p === 0].join(",");
}
function negativeZeroAbsorbed(z: number, m: number, k: number): number {
  const p = (z & 0) * m;                 // every use absorbs the sign: + with an int32 value, | 0
  const t = (p + (k | 0)) | 0;
  return t + ((p | 0) - 3);
}
function bigProducts(a: number, b: number): string {
  const x = a | 0, y = b | 0;            // int32 values, a product up to 2^62: stays a double
  const p = x * y;
  const q = (x * y) | 0;
  const r = (x * 65536) | 0;             // within 2^53: an integer product
  return [p, q, r, (x * y) % 1000, Math.floor(x * y / 7)].join(",");
}
function shifted(v: number): string {
  const a = (v >>> 8) * (v >>> 20), b = (v >> 8) * (v >> 20), c = (v & 0xffff) * (v & 0xfff), d = ((v << 16) >> 16) * ((v << 24) >> 24);
  return [a, b, c, d, (a + b) | 0, Object.is(b, -0)].join(",");
}
function main(): void {
  const q = new Int8Array([127, -128, 3, -3, 0, 100, -100, 1, 64, -64, 5, 7, -9, 11, 13, -17]);
  const x = new Int8Array([-128, -128, 100, 100, 50, 1, -1, 127, 2, -2, 3, 4, 5, 6, 7, 8]);
  console.log(dotInt8(q, 0, x, 0, 16), dotInt8(q, 4, x, 4, 8), dotInt8(q, 0, x, 8, 8), dotInt8(q, 15, x, 15, 1), dotInt8(q, 0, x, 0, 0));
  const u = new Uint8Array([255, 128, 0, 1, 200, 17, 3, 250]), w = new Uint8Array([255, 255, 10, 1, 2, 3, 4, 5]);
  console.log(dotUint8(u, w, 8), dotUint8(u, w, 3), fnv(u), fnv(new Uint8Array(0)), hash31("garnet"), hash31(""), hash31("the quick brown fox jumps over the lazy dog, twice over, for the overflow"));
  console.log(nibbles(0x3a, 5, -7), nibbles(0xff, 1, 1), nibbles(0, 9, 9), nibbles(0x80, -3, 2));
  console.log(negativeZeroObserved(5, -3), negativeZeroObserved(0, -1), negativeZeroObserved(7, 2));
  console.log(negativeZeroAbsorbed(5, -3, 10), negativeZeroAbsorbed(0, -1, 0), negativeZeroAbsorbed(9, 4, -2));
  console.log(bigProducts(2147483647, 2147483647), bigProducts(-2147483648, 2147483647), bigProducts(65536, 65537), bigProducts(3, -4), bigProducts(94906267, 94906267));
  console.log(shifted(0x7fffffff), shifted(-1), shifted(0x12345678), shifted(0), shifted(-2147483648));
  let acc = 0;
  for (let i = 0; i < 1000; i++) { const a = (i & 255) - 128, b = ((i * 7) & 255) - 128; acc = (acc + a * b) | 0; }
  console.log(acc);
}
main();
