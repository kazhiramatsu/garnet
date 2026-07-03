// Calling a non-function, or a method on null/undefined, throws a *catchable*
// TypeError (previously AOT aborted with an uncatchable runtime error). The
// null/undefined-receiver method call is a property-read error and its message
// matches V8 exactly ("Cannot read properties of null (reading 'foo')"); the
// "is not a function" messages omit the source-expression prefix V8 includes
// (no source-text tracking at runtime), so those are checked via instanceof.
function main(): void {
  // method call on null / undefined receiver: property-read TypeError
  try {
    const x: any = null;
    x.foo();
  } catch (e: any) {
    console.log(e instanceof TypeError, e.name, e.message);
  }
  try {
    const x: any = undefined;
    x.bar(1);
  } catch (e: any) {
    console.log(e instanceof TypeError, e.message);
  }

  // nested: x.a is null -> x.a.b() throws the read error for 'b'
  try {
    const x: any = { a: null };
    x.a.b();
  } catch (e: any) {
    console.log(e instanceof TypeError, e.message);
  }

  // calling a non-function value (null / undefined) -> catchable TypeError
  try {
    const f: any = null;
    f();
  } catch (e: any) {
    console.log(e instanceof TypeError);
  }
  try {
    const f: any = undefined;
    f();
  } catch (e: any) {
    console.log(e instanceof TypeError);
  }

  // calling a missing method on a real object -> catchable TypeError
  try {
    const o: any = {};
    o.missing();
  } catch (e: any) {
    console.log(e instanceof TypeError);
  }

  // method call on a primitive `any` with no such method -> catchable TypeError
  try {
    const n: any = 5;
    n.nope();
  } catch (e: any) {
    console.log(e instanceof TypeError);
  }

  // a throw in a callee propagates and is catchable at the call site
  function g(): any {
    const x: any = null;
    return x.foo();
  }
  try {
    g();
  } catch (e: any) {
    console.log("caught", e instanceof TypeError);
  }

  // valid calls are unaffected
  const o: any = { foo() { return 42; } };
  console.log(o.foo());
  const a: any = [3, 1, 2];
  console.log(a.sort((x: number, y: number) => x - y).join(","));
}
main();
