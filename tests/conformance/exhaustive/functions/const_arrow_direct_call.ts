// A module-level `const f = (...) => ...` called directly: before its declaration ran the call is the
// TDZ ReferenceError (V8's), after it the function; recursion through the binding, a function
// expression bound the same way, a const whose initializer is not a function, the binding as a value
// (identity, a call through the value, a method of an object), and arrows that read `this` or
// capture a local (which keep the value call).
function useLater(n: number): number { return double(n) + 1; }
let order = "";
try { order += useLater(1); } catch (e) { order += (e instanceof ReferenceError ? "tdz" : "other"); }
const double = (n: number): number => n * 2;
order += ":" + useLater(1);
const fact = (n: number): number => (n <= 1 ? 1 : n * fact(n - 1));
const greet = function (name: string): string { return "hi " + name; };
const notFn = Math.max(1, 2);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const makeAdder = (k: number) => (x: number) => x + k;   // the inner arrow captures k: a value call
const add3 = makeAdder(3);
const counter = { n: 0, bump() { this.n++; return this.n; } };
const viaThis = function (this: { n: number }): number { return this.n; };
function main(): void {
  console.log(order, fact(5), greet("x"), notFn, isObject({}), isObject(null), isObject("s"), hasOwn({ a: 1 }, "a"), hasOwn({}, "a"));
  const alias = double;
  console.log(alias === double, alias(4), [1, 2, 3].map(double).join(","), typeof double, double.length, (double as unknown as { name: string }).name);
  console.log(add3(4), makeAdder(10)(5), counter.bump(), counter.bump(), viaThis.call({ n: 7 }));
  const table: Record<string, (n: number) => number> = { double, fact };
  console.log(table.double(6), table.fact(4), Object.keys(table).join(","));
  let calls = 0;
  const tick = (): number => { calls++; return calls; };
  for (let i = 0; i < 5; i++) tick();
  console.log(calls, tick(), ((f: () => number) => f())(tick));
}
main();
