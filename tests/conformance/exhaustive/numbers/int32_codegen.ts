// int32 code generation: typed-array elements of every integer kind read into
// bitwise-only locals (Uint32 above 2^31 wraps, an index out of range reads
// undefined, so 0), Math.imul over int locals, constants and non-numbers, and
// the sign of bitwise results at the int32 boundaries.
function imulMix(a: number, b: unknown): number {
  return Math.imul(a, b as number);
}
function hashText(text: Uint16Array, end: number): number {
  let pos = 0 | 0;
  let hash = 2166136261 | 0;
  while (pos < end) {
    const ch = text[pos] | 0;
    hash = Math.imul(hash ^ ch, 16777619);
    pos = (pos + 1) | 0;
  }
  return hash;
}
function sumKinds(i8: Int8Array, u8: Uint8Array, u8c: Uint8ClampedArray, i16: Int16Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, n: number): number[] {
  let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0;
  for (let i = 0; i < n; i++) {
    a = (a + (i8[i] | 0)) | 0;
    b = (b ^ (u8[i] | 0)) | 0;
    c = (c + (u8c[i] | 0)) | 0;
    d = (d ^ (i16[i] | 0)) | 0;
    e = (e + (u16[i] | 0)) | 0;
    f = (f ^ (i32[i] | 0)) | 0;
    g = (g + (u32[i] | 0)) | 0;
  }
  return [a, b, c, d, e, f, g];
}
function main() {
  const n = 10;
  const i8 = new Int8Array(n), u8 = new Uint8Array(n), u8c = new Uint8ClampedArray(n), i16 = new Int16Array(n);
  const u16 = new Uint16Array(n), i32 = new Int32Array(n), u32 = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    i8[i] = -100 + i * 37; u8[i] = 200 + i * 31; u8c[i] = 250 + i * 3; i16[i] = -30000 + i * 7777;
    u16[i] = 60000 + i * 1111; i32[i] = 2147483000 + i * 100; u32[i] = 4294967000 + i * 50;
  }
  const out: unknown[] = [];
  out.push(sumKinds(i8, u8, u8c, i16, u16, i32, u32, n).join(","));
  // out of range: the generic read yields undefined, ToInt32 0, and the loop sums stay finite
  out.push(sumKinds(i8, u8, u8c, i16, u16, i32, u32, n + 3).join(","));
  out.push(u32[0] | 0, u32[9] | 0, (u32[9] | 0) >>> 0, i32[9] | 0, u16[9] | 0, i8[0] | 0, u8c[9] | 0);
  const text = new Uint16Array(64);
  for (let i = 0; i < 64; i++) text[i] = 97 + ((i * 7) % 26);
  out.push(hashText(text, 64), hashText(text, 0), hashText(text, 1), hashText(text, 70));
  out.push(Math.imul(0xffffffff, 5), Math.imul(-2147483648, -1), Math.imul(2147483647, 2147483647), Math.imul(3.9, 2.1), Math.imul(NaN, 7), Math.imul(Infinity, 1));
  out.push(imulMix(7, "6"), imulMix(7, "x"), imulMix(7, true), imulMix(7, null), imulMix(7, undefined), imulMix(7, { valueOf: () => 3 }), imulMix(7, [2]));
  let x = 0x7fffffff | 0, y = 0;
  for (let i = 0; i < 4; i++) { y = (x + 1) | 0; x = y ^ (i << 30); }
  out.push(x, y, (0x80000000 | 0), (0xffffffff | 0), (1 << 31), (-1 >>> 0), (-8 >> 1), (0x7fffffff << 1), (2147483648 | 0) - 1, ((2147483647 | 0) + 1) | 0);
  let acc = 0;
  for (let i = 0; i < 100; i++) acc = (acc + Math.imul(i | 0, 2654435761)) | 0;
  out.push(acc, Math.imul(acc, acc), acc ^ (acc >>> 16));
  console.log(JSON.stringify(out));
}
main();
