// Reading a property off null/undefined throws a catchable TypeError (JS spec).
// Only the dynamic/`any` read path is affected; typed struct field reads keep
// the direct-offset fast path, and optional chaining (`x?.y`) guards the read
// out so it never throws. Previously AOT silently returned undefined.
function main(): void {
  // named read on null / undefined
  try {
    const x: any = null;
    x.foo;
    console.log("no throw");
  } catch (e: any) {
    console.log(e instanceof TypeError, e.name, e.message);
  }
  try {
    const x: any = undefined;
    x.bar;
  } catch (e: any) {
    console.log(e instanceof TypeError, e.message);
  }

  // computed read on null / undefined
  try {
    const x: any = null;
    x["k"];
  } catch (e: any) {
    console.log(e.message);
  }
  try {
    const x: any = undefined;
    x[5];
  } catch (e: any) {
    console.log(e.message);
  }

  // nested: x.a is null -> reading x.a.b throws
  try {
    const x: any = { a: null };
    x.a.b;
  } catch (e: any) {
    console.log(e instanceof TypeError, e.message);
  }

  // optional chaining does NOT throw
  const n: any = null;
  console.log(n?.foo, n?.["k"]);
  const o: any = { a: null };
  console.log(o.a?.b);

  // valid reads are unaffected
  const v: any = { foo: 42, k: 7 };
  console.log(v.foo, v["k"]);
}
main();
