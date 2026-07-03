// Object literal shorthand `{a}` means `{a: a}` — the property value is the
// binding `a`. getSymbolAtLocation on a shorthand name resolves to the PROPERTY
// symbol rather than the referenced variable, so both the free-variable/capture
// analysis AND lowering must redirect to the value binding (else the value reads
// as a fresh empty local: silent 0/undefined).
function make(name: string, age: number) {
  return { name, age, greet() { return this.name; } };
}

const moduleConst = 42;
function readModule() { return { moduleConst }; }

function outer() {
  const v = 10;
  function inner() { return { v }; } // captures a function-local
  return inner();
}

function main(): void {
  // basic locals
  const a = 1, b = 2;
  const o = { a, b };
  console.log(o.a, o.b);                 // 1 2

  // single, mixed with explicit, string value
  const s = "hi";
  console.log({ a }.a, { a, c: 3 }.c, { s }.s); // 1 3 hi

  // JSON sees shorthand props
  console.log(JSON.stringify({ a, b }));  // {"a":1,"b":2}

  // params -> shorthand object (with a method using `this`)
  const p = make("Bob", 30);
  console.log(p.name, p.age, p.greet());  // Bob 30 Bob

  // reassignment between two shorthand literals captures the value at each point
  let m = 1;
  const o1 = { m };
  m = 99;
  const o2 = { m };
  console.log(o1.m, o2.m);                // 1 99

  // round-trips with destructuring
  const { a: x, b: y } = { a, b };
  console.log(x, y);                       // 1 2

  // shorthand mixed with spread
  const base = { x: 0 };
  console.log({ ...base, a }.x, { ...base, a }.a); // 0 1

  // a captured closure cell read through shorthand
  let c = 1;
  const f = () => { const r = { c }; return r.c; };
  c = 5;
  console.log(f());                        // 5

  // module-scope binding via shorthand inside a function
  console.log(readModule().moduleConst);   // 42

  // function-local captured by a nested function via shorthand
  console.log(outer().v);                  // 10

  // a top-level function value as a shorthand property
  function helper() { return 7; }
  console.log({ helper }.helper());        // 7
}

main();
