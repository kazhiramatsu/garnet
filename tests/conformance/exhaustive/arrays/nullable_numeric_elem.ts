// §261: a pure-nullable-number element read (`(number|undefined)[]` /
// `(number|null)[]`) is boxed by §254 for correctness. The flow-sensitive pass
// unboxes the arithmetic-only ones for perf, while OBSERVED reads stay boxed so
// the runtime undefined/null is preserved (not coerced to NaN/0 by an unbox).
function obs(a: (number | undefined)[], i: number): void {
  console.log(a[i], a[i] === undefined, String(a[i]), `v=${a[i]}`);
  const x = a[i];                    // copy into a wider local, then observe
  console.log(x, x === undefined);
}
function arith(a: (number | undefined)[], i: number): number {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k]!; // arithmetic-only: stays unboxed
  const x = a[i]!;
  return s + x * x;                  // copy-then-arithmetic also unboxes
}
function main(): void {
  obs([1, undefined, 3], 1);         // in-bounds undefined element
  obs([1, 2, 3], 9);                 // OOB -> undefined
  obs([1, 2, 3], 0);                 // in-bounds value
  console.log(arith([1, 2, 3, 4], 0)); // 10 + 1 = 11
  // arithmetic with a hole: undefined -> NaN matches JS
  const h: (number | undefined)[] = [1, 2];
  console.log(h[5]! + 1);            // NaN

  // (number|null)[]: null observed stays null; null in arithmetic -> 0 (JS).
  const n: (number | null)[] = [1, null, 3];
  console.log(n[1], n[1] === null, String(n[1]));
  let sn = 0; for (let k = 0; k < n.length; k++) sn += n[k]!; // null->0
  console.log(sn);                   // 1 + 0 + 3 = 4
}
main();
