// Integer-valued doubles in [2^53, 1e21) must print the SHORTEST round-tripping
// decimal (like V8), not the exact value of the double. Two bugs fed this:
// ts_fmt_num used %.0f (exact) and serde_json mis-rounded large bare-integer
// JSON literals by ~1 ULP (now emitted as exponential strings).
function main(): void {
  console.log(123456789012345680000);          // 123456789012345680000
  console.log(1e20, 5e20, -1e20, 1.5e20);
  console.log(999999999999999900000);
  console.log(12345678901234567890);           // < u64 max (exact path)
  console.log(Number.MAX_VALUE, Number.MAX_SAFE_INTEGER);
  console.log(2 ** 53, 2 ** 53 + 2, 2 ** 60);
  // runtime-computed large integers (exercises ts_fmt_num, not the constant path)
  let a = 1e10;
  console.log(a * a * 12, (1e11) * (1e10));
  console.log(String(123456789012345680000), `${1e20}`, (5e20).toString());
}
main();
