// Integer multiplication is only kept on the i64 (long long) fast path when the
// product provably stays within ±2^53. A product of two unbounded i64-safe
// values can reach ~2^106 and wrap a long long (2^63) into garbage, whereas JS
// number (double) loses precision / goes to Infinity. The analyzer now drops
// such products to an unboxed double so they match V8. Well-bounded products
// (modulo/mask operands) keep the fast i64 path and exact values.
function main(): void {
  // multiplicative accumulation that overflows a long long -> JS: Infinity
  let s = 0;
  for (let i = 0; i < 100; i++) s = s * 1000000 + 1;
  console.log(s); // Infinity

  // factorials past 2^53 lose precision exactly as double does
  let f = 1;
  for (let i = 1; i <= 21; i++) f *= i;
  console.log(f); // 51090942171709440000

  // repeated doubling past 2^53 (still exact powers of two, but as double)
  let x = 2;
  for (let i = 0; i < 60; i++) x = x * 2;
  console.log(x); // 2305843009213693952

  // negative accumulation
  let p = 1;
  for (let i = 1; i <= 22; i++) p = p * -i;
  console.log(p);

  // single products that exceed 2^53 (no wrap, but double precision)
  const b = 94906265; // ~sqrt(2^53)
  console.log(b * b);
  console.log(2 ** 53, 2 ** 53 + 1, 2 ** 60);

  // BOUNDED products stay exact on the i64 path (the perf-critical case):
  // (i%1000)*((n-i)%1000) has range [0, 998001] < 2^53.
  let acc = 0;
  for (let i = 0; i < 1000; i++) {
    acc = (acc + (i % 1000) * ((1000 - i) % 1000)) % 1000007;
  }
  console.log(acc);

  // small exact products are unaffected
  console.log(1000000 * 1000000, 7 * 8, 3000000 * 3000000);

  // a normal additive sum (well within 2^53) stays exact
  let sum = 0;
  for (let i = 0; i < 1000000; i++) sum += i;
  console.log(sum); // 499999500000
}
main();
