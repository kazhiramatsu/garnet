// ToInt32 / ToUint32 at the edges through every bitwise operator on typed
// numbers (the ARM64 path is one FJCVTZS instruction): NaN, the infinities,
// signed zeros, fractions, the int32 and uint32 bounds, values past 2^32 and
// 2^53, and large magnitudes.
function main(): void {
  const vals: number[] = [0, -0, 0.5, -0.5, 1.9999, -1.9999, 2147483647, 2147483648, -2147483648, -2147483649,
    4294967295, 4294967296, 4294967301, -4294967301, 9007199254740991, 9007199254740993, 1e20, -1e20, 1.5e300,
    -1.5e300, Infinity, -Infinity, NaN, 524288, 3.99e9, -3.99e9, 0xdeadbeef, 2 ** 31 + 0.5, -(2 ** 31) - 0.5];
  const out: string[] = [];
  for (const v of vals) {
    const s = 7 + (out.length % 3);
    out.push([v | 0, v & 0xffff, v ^ -1, ~v, v << 1, v >> s, v >>> s, v >>> 0, (v | 0) === (v >> 0)].join(","));
  }
  console.log(out.join(" | "));
  let acc = 0;
  for (let i = 0; i < 100000; i++) { const x = i * 1234567.891 - 5e7; acc = (acc + (x | 0) + (x >>> 3) + (~x & 255)) | 0; }
  console.log(acc);
}
main();
