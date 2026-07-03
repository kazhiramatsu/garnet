// Built-in Error family: instanceof, prototype chain, inherited name, toString,
// message (own non-enumerable), subclassing, and catchable thrown errors.
class AppErr extends Error { code = 42; }
class WrapErr extends Error { constructor(m: string) { super(m); this.name = "WrapErr"; } }

function main(): void {
  const e = new Error("boom");
  console.log(e instanceof Error, e instanceof Object, e.name, e.message, String(e));
  // subtypes chain to Error
  for (const x of [new TypeError("t"), new RangeError("r"), new SyntaxError("s"), new ReferenceError("ref")]) {
    console.log(x.name, x instanceof Error, x instanceof Object, String(x));
  }
  // negatives
  console.log(5 as any instanceof Error, ({} as any) instanceof Error, new Error() instanceof TypeError);
  // message non-enumerable; user fields enumerable
  const e2 = new Error("x"); (e2 as any).extra = 1;
  console.log(Object.keys(e2).join(","));
  // subclass: instanceof, inherited name default, own field, message
  const a = new AppErr("oops");
  console.log(a instanceof AppErr, a instanceof Error, a instanceof Object, a.name, a.message, a.code, Object.keys(a).sort().join(","));
  // subclass with own name
  const w = new WrapErr("w");
  console.log(w.name, w.message, w instanceof Error, String(w));
  // throw / catch with type discrimination
  try { throw new RangeError("bad"); } catch (err) {
    console.log(err instanceof RangeError, err instanceof Error, (err as Error).message);
  }
  // catchable JSON.parse SyntaxError
  try { JSON.parse("{not json"); } catch (err) { console.log(err instanceof SyntaxError, err instanceof Error); }
  // deep subclass chain
  class A extends Error {} class B extends A {}
  const b = new B("m");
  console.log(b instanceof B, b instanceof A, b instanceof Error, b.message);
}
main();
