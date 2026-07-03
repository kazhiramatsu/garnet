// ++/-- always operate numerically (ToNumber(operand) +/- 1), even when the
// operand is `any`/string-typed. Both the stored value and the postfix snapshot
// must be numbers. Previously `++` lowered to a string-aware `+` (ts_add),
// miscompiling string/`any` operands to NaN.
function main(): void {
  let a: any = "5";
  a++;
  console.log(a, typeof a);            // 6 number

  let b: any = "5";
  const ob = b++;
  console.log(ob, b, typeof ob);       // 5 6 number

  let c: any = "10";
  const oc = c--;
  console.log(oc, c, typeof oc);       // 10 9 number

  let d: any = "5";
  console.log(++d, d);                 // 6 6

  let e: any = "";
  e++;
  console.log(e);                      // 1

  let f: any = "abc";
  f++;
  console.log(f);                      // NaN

  let g: any = true;
  g++;
  console.log(g);                      // 2

  let h: any = null;
  h++;
  console.log(h);                      // 1

  const o: any = { n: "5" };
  o.n++;
  console.log(o.n, typeof o.n);        // 6 number

  // numeric fast path stays intact
  let s = 0;
  for (let i = 0; i < 5; i++) s += i;
  console.log(s);                      // 10
}
main();
