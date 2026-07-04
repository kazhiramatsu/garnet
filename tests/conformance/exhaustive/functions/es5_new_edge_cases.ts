// ES5 function-constructor edge cases (s319 follow-up). The delete case found
// a real silent DIFF: a prototype-method store writes BOTH key spaces
// (StoreField + StoreMethod, the dynamic-dispatch bridge), but delete only
// cleared the FIELD key — reads saw the method gone while calls still resolved
// through the METHOD-side fallback. DeleteField now carries the METHOD twin id
// (fixed on the Rust side only; the frozen twin keeps the bug -> KNOWN).
function Foo(this: any, n: number) { this.n = n; }
(Foo.prototype as any).m = function (this: any) { return this.n; };

function Ret(this: any) { this.a = 1; return this; }   // return this === the instance

let order = "";
function side(tag: string, v: number): number { order += tag; return v; }

function main(): void {
  // argument evaluation order under new
  const f: any = new Foo(side("a", 1) + side("b", 2));
  console.log(order, f.n);

  // `return this` from the ctor: still the fresh instance (object return rule)
  const R: any = Ret;
  console.log(new R().a);

  // ES5 ctor invoked via .call with an explicit receiver
  const obj: any = {};
  Foo.call(obj, 9);
  console.log(obj.n);

  // prototype reassigned to a NON-object: construction falls back to
  // Object.prototype (methods gone), but the function stays a constructor
  (Foo as any).prototype = 5;
  const g: any = new Foo(3);
  console.log(g.n, g.m === undefined);
  try { g.m(); } catch (e: any) { console.log(e instanceof TypeError); }

  // deleting a prototype method must break BOTH the read and the dispatch
  function Bar(this: any) { this.b = 1; }
  (Bar.prototype as any).k = function () { return 1; };
  const h: any = new Bar();
  console.log(h.k());
  delete (Bar.prototype as any).k;
  console.log(h.k === undefined);
  try { h.k(); } catch (e: any) { console.log(e instanceof TypeError); }

  // constructor overwrite does not affect instanceof (proto chain only)
  (h as any).constructor = Foo;
  console.log(h instanceof Bar, h.constructor === Foo);

  // strict receiver edges: compound assignment + optional-chain reads
  const u: any = undefined;
  try { u.x += 1; } catch (e: any) { console.log(e instanceof TypeError); }
  console.log(u?.x);
  const num: any = 5;
  console.log(num?.toFixed(1), num?.missing);
}
main();
