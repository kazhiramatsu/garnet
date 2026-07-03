function main(): void {
  const o: any = { a: 1 };
  // enumerable accessor: listed in keys, getter invoked for values/JSON
  Object.defineProperty(o, "x", { get(): number { return 2; }, enumerable: true });
  console.log(Object.keys(o).join(","));     // a,x
  console.log(Object.values(o).join(","));   // 1,2
  console.log(JSON.stringify(o));            // {"a":1,"x":2}
  // non-enumerable accessor (default): not listed
  const o2: any = { a: 1 };
  Object.defineProperty(o2, "y", { get(): number { return 9; } });
  console.log(Object.keys(o2).join(","));    // a
  console.log(o2.y);                         // 9 (still readable directly)
}
main();
