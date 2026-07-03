function main(): void {
  const o: any = {};
  Object.defineProperties(o, {
    a: { value: 1, enumerable: true },
    b: { value: 2 },                       // non-enumerable
    c: { get(): number { return 3; } },    // accessor shorthand
  });
  console.log(o.a, o.b, o.c);              // 1 2 3
  console.log(Object.keys(o).join(","));   // a
}
main();
