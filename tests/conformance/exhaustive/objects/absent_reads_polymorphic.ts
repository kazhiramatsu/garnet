// Absent-property reads on arrays, numbers, strings and booleans at one polymorphic site (a
// library's `isRef(v)` reads `v.__v_isRef` on every value) are answered from the absent-property
// table: a property added to or deleted from Array.prototype, Number.prototype, String.prototype,
// Boolean.prototype or Object.prototype afterwards, a replaced prototype, a getter reached from a
// primitive and a string's own length and indices must still be seen.
function probe(v: any): string { return v.__v_isRef === true ? "ref" : v.__v_isRef === undefined ? "none" : String(v.__v_isRef); }
function main(): void {
  const values: any[] = [1, "s", true, [1, 2], { __v_isRef: true }, { a: 1 }, 2.5, "", false, [], 0];
  const run = () => values.map(probe).join(",");
  console.log(run()); console.log(run());
  (Array.prototype as any).__v_isRef = "arr"; console.log(run());
  (Number.prototype as any).__v_isRef = "num"; (String.prototype as any).__v_isRef = "str"; (Boolean.prototype as any).__v_isRef = "bool"; console.log(run());
  delete (Array.prototype as any).__v_isRef; delete (Number.prototype as any).__v_isRef; console.log(run());
  (Object.prototype as any).__v_isRef = "obj"; console.log(run());
  delete (Object.prototype as any).__v_isRef; delete (String.prototype as any).__v_isRef; delete (Boolean.prototype as any).__v_isRef; console.log(run());
  const arr: any = [7]; console.log(arr.length, arr[0], arr["0"], arr.zz, "zz" in arr); Object.setPrototypeOf(arr, { zz: "p" }); console.log(arr.zz, arr.length, probe(arr));
  const s: any = "héllo"; console.log(s.length, s[1], s.zz, s.toUpperCase(), (5 as any).zz, (5).toFixed(1), (true as any).zz);
  // a getter on a prototype, reached from a primitive, sees the primitive as its receiver
  Object.defineProperty(Number.prototype, "twice", { get() { return (this as any) * 2; }, configurable: true });
  console.log((21 as any).twice, (1.5 as any).twice); delete (Number.prototype as any).twice; console.log((21 as any).twice);
  // many values through one site, then a late addition seen by the same site
  let n = 0;
  for (let i = 0; i < 2000; i++) { const v: any = i % 3 === 0 ? i : i % 3 === 1 ? "x" + i : [i]; if (v.__v_isRef === undefined) n++; }
  (Array.prototype as any).__v_isRef = 1;
  for (let i = 0; i < 300; i++) { const v: any = i % 2 ? [i] : i; if (v.__v_isRef === undefined) n += 100; }
  delete (Array.prototype as any).__v_isRef; console.log(n);
  const frozenProto = Object.freeze({ fz: 1 }); const o2: any = Object.create(frozenProto); console.log(o2.fz, o2.zz, probe(o2));
}
main();
