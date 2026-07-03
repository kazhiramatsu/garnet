function main(): void {
  // reduce without an initial value: accumulator = first element.
  console.log([1, 2, 3].reduce((a, b) => a * b));      // 6
  console.log([1, 2, 3, 4].reduce((a, b) => a + b));   // 10
  console.log([42].reduce((a, b) => a + b));           // 42 (single elem, cb not called)
  console.log(["a", "b", "c"].reduce((a, b) => a + b)); // abc
  // reduce WITH an initial value still works.
  console.log([1, 2, 3].reduce((a, b) => a + b, 100)); // 106
}
main();
