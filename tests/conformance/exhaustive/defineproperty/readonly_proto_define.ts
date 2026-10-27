// A read-only data property defined on an object that is (or becomes) a prototype must reject the
// inherited write of every object below it, even at an assignment site that was warm before the define
// (the addition caches); the same define on an object that is nobody's prototype changes only that
// object. Class prototypes, Object.create chains, setPrototypeOf links, a constructor function's
// prototype, a getter-only accessor, and the instance case (Object.defineProperty(this, k, { value }) in
// a constructor, as yaml's nodes do) with later writes of other keys through the same sites.
interface Bag { [k: string]: unknown }
function addAt(o: Bag, v: number): string {   // one addition site, many receivers
  try { o.mark = v; return "ok"; } catch (e) { return (e as Error).constructor.name; }
}
function setTag(o: Bag, v: string): string {
  try { o.tag = v; return "ok"; } catch (e) { return (e as Error).constructor.name; }
}
class Leaf { constructor(public id: number) { Object.defineProperty(this, "kind", { value: "node" }); } }
function Legacy(this: Bag, n: number) { this.n = n; }
function main(): void {
  const out: string[] = [];
  const base: Bag = {};
  const kids: Bag[] = [];
  for (let i = 0; i < 5; i++) { const k = Object.create(base) as Bag; kids.push(k); out.push(addAt(k, i)); }   // warm: additions succeed
  Object.defineProperty(base, "mark", { value: 99 });            // read-only on the prototype
  const late = Object.create(base) as Bag;
  out.push(addAt(late, 7), String(late.mark), String(kids[0].mark), String(Object.keys(late).length));
  // setPrototypeOf after the fact
  const p2: Bag = {}; const c2: Bag = {};
  out.push(setTag(c2, "a"));                                       // own tag added (warm)
  const c3: Bag = {}; Object.setPrototypeOf(c3, p2);
  Object.defineProperty(p2, "tag", { value: "fixed" });
  out.push(setTag(c3, "b"), String(c3.tag), setTag({} as Bag, "c"));
  // a class prototype
  const n1 = new Leaf(1), n2 = new Leaf(2);
  out.push(addAt(n1 as unknown as Bag, 1), String((n1 as unknown as Bag).kind), String(Object.keys(n1).join(",")));
  Object.defineProperty(Leaf.prototype, "mark", { value: -1 });
  out.push(addAt(n2 as unknown as Bag, 2), String((n2 as unknown as Bag).mark), String((n1 as unknown as Bag).mark));
  // a constructor function's prototype
  const l1 = new (Legacy as unknown as new (n: number) => Bag)(1);
  out.push(addAt(l1, 3));
  Object.defineProperty((Legacy as unknown as { prototype: Bag }).prototype, "mark", { value: 5 });
  const l2 = new (Legacy as unknown as new (n: number) => Bag)(2);
  out.push(addAt(l2, 4), String(l2.mark), String(l1.mark));
  // a getter-only accessor on the prototype
  const ap: Bag = {}; const ac = Object.create(ap) as Bag;
  out.push(setTag(ac, "x"));
  const ac2 = Object.create(ap) as Bag;
  Object.defineProperty(ap, "tag", { get() { return "got"; } });
  out.push(setTag(ac2, "y"), String(ac2.tag), String(ac.tag));
  // the instance case: read-only defines on non-prototypes do not disturb other additions
  const inst: Bag = {}; Object.defineProperty(inst, "frozenKey", { value: 1 });
  out.push(addAt(inst, 8), String(inst.frozenKey), addAt({} as Bag, 9), String(Object.keys(inst).join(",")));
  console.log(out.join("\n"));
}
main();
