function main(): void {
  // basic default; later default referencing earlier params.
  function f(a: number, b = 10, c = a + b): number { return a + b + c; }
  console.log(f(1), f(1, 2), f(1, 2, 3));      // 22 6 6

  // explicit undefined triggers the default; a value overrides it.
  function g(a = 5): number { return a; }
  console.log(g(), g(undefined), g(7));        // 5 5 7

  // string default.
  function h(name = "world"): string { return "hi " + name; }
  console.log(h(), h("ts"));                   // hi world | hi ts

  // default expression referencing an earlier param.
  function k(a: number, b = a * 2): number { return b; }
  console.log(k(3), k(3, 100));                // 6 100
}
main();
