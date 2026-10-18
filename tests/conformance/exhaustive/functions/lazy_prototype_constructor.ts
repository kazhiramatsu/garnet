// Function declarations and expressions receive a fresh `.prototype` object at
// closure creation. The runtime defines its own `constructor` property lazily
// (on the first observation of fn.prototype through a read, `new`, or a
// descriptor), so every observable path below must agree with V8.
function Decl(this: any, v: number) { this.v = v; }
const Expr = function (this: any, v: number) { this.v = v * 2; };

function makeInner(n: number) {
  function Inner(this: any) { this.n = n; }
  return Inner as any;
}

function describe(fn: any): string {
  const d = Object.getOwnPropertyDescriptor(fn.prototype, "constructor")!;
  return [d.value === fn, d.writable, d.enumerable, d.configurable].join(",");
}

function main(): void {
  // read path: fn.prototype.constructor is the function itself, non-enumerable
  console.log(Decl.prototype.constructor === Decl, Expr.prototype.constructor === Expr);
  console.log(Object.getOwnPropertyNames(Decl.prototype).join("|"), Object.keys(Decl.prototype).length);
  console.log(Object.prototype.hasOwnProperty.call(Expr.prototype, "constructor"));
  console.log(describe(Decl), describe(Expr));
  const keys: string[] = [];
  for (const k in Decl.prototype) keys.push(k);
  console.log(keys.length);

  // construct path: the instance sees constructor through the chain
  const d: any = new (Decl as any)(3);
  console.log(d.v, d.constructor === Decl, Object.getPrototypeOf(d) === Decl.prototype, d instanceof Decl);
  console.log(Object.keys(d).join("|"), "constructor" in d, d.hasOwnProperty("constructor"));

  // descriptor path on the function itself
  const pd = Object.getOwnPropertyDescriptor(Decl, "prototype")!;
  console.log(pd.writable, pd.enumerable, pd.configurable, pd.value === Decl.prototype, pd.value.constructor === Decl);

  // reassigning .prototype before any observation drops the pending constructor
  function Fresh(this: any) { this.z = 1; }
  (Fresh as any).prototype = { tag: "replaced" };
  console.log(Fresh.prototype.constructor === Object, (Fresh.prototype as any).tag);
  const f: any = new (Fresh as any)();
  console.log(f.tag, f.constructor === Object, f.constructor === Fresh);

  // nested declarations: a distinct prototype and constructor per invocation,
  // with enough churn in between for collections to move or promote them.
  const made: any[] = [];
  for (let i = 0; i < 2000; i++) {
    made.push(makeInner(i));
    if (i % 7 === 0) { const junk: number[] = []; for (let j = 0; j < 300; j++) junk.push(j); }
  }
  let ok = true;
  for (let i = 0; i < made.length; i += 97) {
    const C = made[i];
    const inst = new C();
    if (C.prototype.constructor !== C || inst.constructor !== C || inst.n !== i) ok = false;
    if (made[(i + 1) % made.length].prototype === C.prototype) ok = false;
  }
  console.log(ok, made[0].prototype.constructor === made[0], made[1].prototype.constructor === made[0]);

  // instanceof on a plain function resolves fn.prototype
  console.log(d instanceof Expr, new (Expr as any)(1) instanceof Expr);

  // prototype methods added before and after construction are shared
  (Decl.prototype as any).get = function (this: any) { return this.v; };
  console.log(d.get(), new (Decl as any)(9).get(), Object.getOwnPropertyNames(Decl.prototype).join("|"));
}
main();
