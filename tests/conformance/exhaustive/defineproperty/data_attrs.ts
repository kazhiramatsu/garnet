function main(): void {
  const o: any = {};
  o.a = 1;
  // omitted attributes default to false: b is non-enumerable
  Object.defineProperty(o, "b", { value: 2 });
  console.log(Object.keys(o).join(","));   // a
  console.log(o.b);                        // 2 (still readable)
  // explicit enumerable:true
  Object.defineProperty(o, "c", { value: 3, enumerable: true });
  console.log(Object.keys(o).join(","));   // a,c
  // all-true behaves like a normal property
  Object.defineProperty(o, "d", { value: 4, enumerable: true, writable: true, configurable: true });
  console.log(Object.keys(o).join(","), o.d); // a,c,d 4
}
main();
