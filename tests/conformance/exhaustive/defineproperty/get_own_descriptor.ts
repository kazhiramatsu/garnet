function main(): void {
  const o: any = { a: 1 };
  const d1 = Object.getOwnPropertyDescriptor(o, "a");
  console.log(d1.value, d1.writable, d1.enumerable, d1.configurable);  // 1 true true true
  Object.defineProperty(o, "b", { value: 5 });   // omitted -> all false
  const d2 = Object.getOwnPropertyDescriptor(o, "b");
  console.log(d2.value, d2.writable, d2.enumerable, d2.configurable);  // 5 false false false
  const miss = Object.getOwnPropertyDescriptor(o, "nope");
  console.log(miss === undefined);                // true
  Object.defineProperty(o, "g", { get(): number { return 9; }, configurable: true });
  const d3 = Object.getOwnPropertyDescriptor(o, "g");
  console.log(typeof d3.get, typeof d3.set, d3.enumerable, d3.configurable); // function undefined false true
}
main();
