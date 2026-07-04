// Non-constructables under `new`: arrows, async functions, generators, object
// methods, and non-functions all throw a CATCHABLE TypeError (V8 shape
// "... is not a constructor"), never silently construct. The message's name part
// is V8's new-site expression vs our boxed fn name, so tests match on the tail.
// instanceof mirrors it: a prototype-less function RHS and a non-callable RHS
// both throw V8's TypeErrors (exact messages — no name interpolation there).
const arrow = () => {};
async function af() {}
function* gf() { yield 1; }
const holder = { m() { return 1; } };

function Foo(this: any) { this.a = 1; }

function tryNew(f: any, label: string) {
  try { new f(); console.log(label, "constructed"); }
  catch (e: any) { console.log(label, e instanceof TypeError, /is not a constructor$/.test(e.message)); }
}

function main(): void {
  tryNew(arrow, "arrow");
  tryNew(af, "async");
  tryNew(gf, "gen");
  tryNew(holder.m, "method");
  tryNew(123, "num");
  tryNew(undefined, "undef");

  // instanceof with a prototype-less function RHS throws (exact V8 message)
  const x: any = new Foo();
  const arrowAny: any = arrow;
  try { console.log(x instanceof arrowAny); }
  catch (e: any) { console.log("iarrow", e instanceof TypeError, e.message); }

  // instanceof with a non-callable RHS throws (exact V8 message)
  const plain: any = {};
  try { console.log(x instanceof plain); }
  catch (e: any) { console.log("iplain", e instanceof TypeError, e.message); }

  // sanity: the constructable path still works next to the throwing ones
  const F: any = Foo;
  console.log(new F().a, x instanceof F);
}
main();
