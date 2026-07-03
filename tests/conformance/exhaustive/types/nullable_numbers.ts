// A nullable numeric (`number | null` / `number | undefined`) must keep its
// null/undefined at runtime — it must NOT be unboxed to a raw double (which would
// turn null into NaN/0). The checker runs with strictNullChecks so the union is
// preserved and classified as a boxed reference. Covers field/param/return/
// intermediate-local flows plus narrowing back to arithmetic.
class Box {
  v: number | null;
  constructor(x: number | null) { this.v = x; }
}
function mk(x: number | null): Box { return new Box(x); }
function pick(c: boolean): number | undefined { return c ? 1 : undefined; }
function opt(x?: number): number | undefined { return x; }

function main(): void {
  // field read via a function-call receiver (the original miscompile)
  console.log(mk(null).v, mk(5).v);              // null 5
  // through an un-annotated intermediate local
  const r = mk(null);
  const y = r.v;
  console.log(y);                                // null
  const r2 = mk(42);
  console.log(r2.v);                             // 42
  // number|undefined return, both branches
  console.log(pick(true), pick(false));          // 1 undefined
  // optional numeric parameter
  console.log(opt(7), opt());                    // 7 undefined
  // narrowing back to arithmetic (boxed value still computes correctly)
  const a: number | null = mk(10).v;
  console.log((a ?? 0) + 1);                      // 11
  const b: number | null = mk(null).v;
  console.log(b === null ? "isnull" : b + 1);    // isnull
  if (a !== null) console.log(a * 2);            // 20
  // nullable numbers in containers
  const arr: (number | null)[] = [1, null, 3];
  console.log(arr.map(n => (n === null ? "_" : String(n))).join(",")); // 1,_,3
  const m = new Map<string, number | null>();
  m.set("a", null); m.set("b", 9);
  console.log(m.get("a"), m.get("b"));           // null 9
}
main();
