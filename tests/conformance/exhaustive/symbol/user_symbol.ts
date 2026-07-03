function main(): void {
  const s = Symbol("desc");
  console.log(typeof s);            // symbol
  console.log(s.description);       // desc
  const a = Symbol();
  const b = Symbol();
  console.log(a === b, a === a);    // false true
  console.log(Symbol().description === undefined); // true
  // symbol-keyed property
  const o: any = {};
  o[s] = 42;
  console.log(o[s]);                // 42
  // distinct symbols are distinct keys
  o[a] = 1; o[b] = 2;
  console.log(o[a], o[b]);          // 1 2
  // symbol keys are not enumerated
  console.log(Object.keys(o).length); // 0
}
main();
