// A `number[]` out-of-bounds / hole read is `undefined` at runtime. Observing it
// (console.log, ===, String, copy-then-observe) must yield undefined, not NaN —
// while purely-arithmetic use stays unboxed (undefined→NaN matches JS).
function obs(a: number[], i: number): void {
  console.log(a[i], a[i] === undefined, String(a[i]), `v=${a[i]}`);
  const x = a[i];
  const y = x;
  console.log(x, y);                 // copy + copy-chain propagation
}
function arith(a: number[], i: number): number {
  const x = a[i];
  return x * x + a[i] - 1;           // arithmetic: NaN for OOB, matches JS
}
function main(): void {
  obs([1, 2, 3], 9);                 // all undefined
  obs([1, 2, 3], 1);                 // in-bounds: 2 ...
  console.log(arith([1, 2, 3], 9));  // NaN
  console.log(arith([1, 2, 3], 0));  // 1*1+1-1 = 1
  // holes from length extend, read in a loop
  const h: number[] = [10, 20];
  h.length = 4;
  for (let i = 0; i < 4; i++) console.log(h[i], h[i] === undefined);
  // sum loop over OOB range (arithmetic) matches JS NaN
  let s = 0; for (let i = 0; i < 5; i++) s += [1, 2, 3][i]; console.log(s);
}
main();

// Constant out-of-bounds reads and short-array destructuring (SROA scalar-replaces
// these into a Reference undefined scalar copied into a numeric local) must also
// observe undefined, not NaN.
function constOob(): void {
  const a = [1, 2, 3];
  console.log(a[10], a[5] === undefined, String(a[7]), `${a[9]}`);
  const x = a[8];
  console.log(x);
  const [p, q, r] = [10, 20];        // r is out of range
  console.log(p, q, r, r === undefined);
  console.log(p + q);                // in-bounds arithmetic
}
constOob();
