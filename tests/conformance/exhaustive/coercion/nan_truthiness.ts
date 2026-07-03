// NaN is falsy (ToBoolean(NaN) === false). A raw unboxed double must guard the
// NaN case: `d != 0` alone is true for NaN in C, but NaN is falsy in JS.
function main(): void {
  const n: number = NaN;
  console.log(n ? "t" : "f");                 // f
  console.log(!n);                            // true
  console.log(n && "y");                      // NaN (short-circuits on falsy)
  console.log(n || "z");                      // z
  if (n) { console.log("if-t"); } else { console.log("if-f"); } // if-f

  // NaN produced at runtime by a float op
  const r: number = Math.sqrt(-1);
  console.log(r ? 1 : 0);                      // 0

  // while over a NaN counter never enters the body
  let c: number = 0;
  let m: number = 0 / 0;
  while (m) { c++; break; }
  console.log(c);                              // 0

  // ternary feeding an int local
  const y: number = NaN ? 10 : 20;
  console.log(y);                              // 20

  // !! coercion alongside other falsy/truthy numbers (regression guard)
  console.log(!!NaN, !!0, !!-0, !!1, !!0.5, !!-3.14); // false false false true true true

  // NaN stored in a field / array element stays falsy
  const o = { v: NaN };
  console.log(o.v ? "t" : "f");                // f
  const a: number[] = [NaN, 1];
  console.log(a[0] ? "t" : "f", a[1] ? "t" : "f"); // f t

  // non-NaN doubles keep working: nonzero truthy, zero falsy
  const x: number = 3.14;
  console.log(x ? "t" : "f", (0.0) ? "t" : "f"); // t f
}

main();
