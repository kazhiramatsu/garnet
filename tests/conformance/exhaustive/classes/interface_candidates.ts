// A field read or written through an interface a few classes implement: the site tests those classes
// itself (docs/pic_sized_inline_design.md, "The candidate classes in line"), so everything else that
// satisfies the interface must still behave: another layout, a subclass, an accessor, a plain object,
// a relinked or frozen instance, a deleted field, a Proxy, and cells of other kinds at the same site.
interface Node1 {
  next: Node1 | undefined;
  weight: number;
  label: string;
}

class First implements Node1 {
  next: Node1 | undefined = undefined;
  weight = 1.5;
  label = "first";
}

class Second implements Node1 {
  pad0 = "x";
  pad1 = 2;
  label = "second";
  weight = 2.5;
  next: Node1 | undefined = undefined;
}

class SecondSub extends Second {
  extra = "sub";
}

class Accessed implements Node1 {
  store = 7;
  log: string[] = [];
  get next(): Node1 | undefined { this.log.push("get next"); return undefined; }
  set next(_v: Node1 | undefined) { this.log.push("set next"); }
  get weight(): number { return this.store * 2; }
  set weight(v: number) { this.store = v; }
  get label(): string { return "accessed"; }
  set label(_v: string) { this.log.push("set label"); }
}

function readAll(n: Node1): string {
  return `${n.label}:${n.weight}:${n.next === undefined ? "none" : n.next.label}`;
}
function writeAll(n: Node1, w: number, l: string, nx: Node1 | undefined): void {
  n.weight = w;
  n.label = l;
  n.next = nx;
}
// the same sites with boxed values: a member may be missing here
interface Loose { next?: Node1; weight?: number; label?: string }
function readLoose(n: Loose): string {
  return `${n.label}:${n.weight}:${n.next === undefined ? "none" : n.next.label}`;
}

// integer slots: every static store of `count` is an integer
interface Counted { count: number; tag?: string }
class CountA implements Counted { count = 0; bump() { this.count = this.count + 1; } }
class CountB implements Counted { pad = 1; count = 10; tag = "b"; }
function addOne(c: Counted): number { c.count = c.count + 1; return c.count; }

// a union of more classes than the site tests by its declaring class: a shared base's field
class Base { kind = "base"; size = 1; }
class D1 extends Base { a = 1; }
class D2 extends Base { b = 2; }
class D3 extends Base { c = 3; }
class D4 extends Base { d = 4; }
class D5 extends Base { e = 5; }
class D6 extends Base { f = 6; }
class D7 extends Base { g = 7; }
class D8 extends Base { h = 8; }
class D9 extends Base { i = 9; }
class D10 extends Base { j = 10; }
type Many = D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | D9 | D10;
function kindOf(m: Many): string { return m.kind + m.size; }

// cells of other kinds that satisfy structural interfaces
interface HasLength { length: number }
class Len implements HasLength { length = 3; }
function lengthOf(h: HasLength): number { return h.length; }
interface HasSize { size: number }
class Sz implements HasSize { size = 4; }
function sizeOf(h: HasSize): number { return h.size; }
interface HasMessage { message: string; name: string }
class Msg implements HasMessage { message = "m"; name = "Msg"; }
function messageOf(h: HasMessage): string { return h.name + "/" + h.message; }
interface HasDescription { description: string | undefined }
class Desc implements HasDescription { description: string | undefined = "d"; }
function descriptionOf(h: HasDescription): string | undefined { return h.description; }
interface HasNext { next: unknown }
class Nx implements HasNext { next: unknown = 1; }
function hasNextType(h: HasNext): string { return typeof h.next; }
interface HasLastIndex { lastIndex: number }
class LastIdx implements HasLastIndex { lastIndex = 9; }
function lastIndexOf(h: HasLastIndex): number { return h.lastIndex; }
function setLastIndex(h: HasLastIndex, v: number): void { h.lastIndex = v; }

function* gen(): Generator<number> { yield 1; }

function attempt(f: () => unknown): string {
  try { return String(f()); } catch (e) { return (e as Error).constructor.name; }
}

function main(): void {
  const a = new First();
  const b = new Second();
  const c = new SecondSub();
  const d = new Accessed();
  const plain: Node1 = { next: undefined, weight: 9, label: "plain" };
  const all: Node1[] = [a, b, c, d, plain];
  console.log(all.map(readAll).join(" "));
  for (const n of all) writeAll(n, 3.25, n.label + "!", a);
  console.log(all.map(readAll).join(" "));
  console.log(d.log.join(","), Object.keys(b).join(","), JSON.stringify(plain.weight));

  // an instance in a loop: a read and a write per round, mixed with a plain object
  let sum = 0;
  const walk: Node1[] = [new First(), new Second(), new SecondSub(), { next: undefined, weight: 1, label: "p" }];
  for (let i = 0; i < 2000; i++) {
    const n = walk[i % 4];
    n.weight = n.weight + 1;
    sum += n.weight;
  }
  console.log(sum);

  // relinked: the instance leaves the interval; own fields are still its own
  const rel = new Second();
  const relinked = Object.setPrototypeOf(rel, { inherited: 1 }) as Node1;
  console.log(readAll(relinked));
  relinked.weight = 8;
  console.log(relinked.weight, Object.keys(rel).join(","));

  // frozen: reads as before, a write is a TypeError and leaves the value
  const fz = Object.freeze(new First());
  console.log(readAll(fz), attempt(() => { (fz as Node1).weight = 1; }), attempt(() => { (fz as Node1).label = "z"; }), fz.weight, fz.label);
  // sealed and non-extensible: the fields stay writable
  const sealed = Object.seal(new Second());
  writeAll(sealed, 4, "sealed", undefined);
  const noext = Object.preventExtensions(new First());
  writeAll(noext, 5, "noext", sealed);
  console.log(readAll(sealed), readAll(noext));

  // a deleted field: the instance is a dictionary, and the prototype's property shows through
  const del = new First() as any;
  delete del.weight;
  console.log(readLoose(del));
  (First.prototype as any).weight = 77;
  console.log(readLoose(del), readLoose(new First()));
  delete (First.prototype as any).weight;

  // an object made from a class's prototype, without the instance's layout
  const fake = Object.create(First.prototype) as Node1;
  console.log(readLoose(fake), attempt(() => readLoose(fake)));
  fake.weight = 6;
  console.log(fake.weight, Object.keys(fake).join(","));

  // a Proxy of an instance: every access takes the traps
  const trace: string[] = [];
  const px = new Proxy(new Second() as Node1, {
    get(t, k, r) { trace.push("get " + String(k)); return Reflect.get(t, k, r); },
    set(t, k, v, r) { trace.push("set " + String(k)); return Reflect.set(t, k, v, r); },
  });
  console.log(readAll(px));
  writeAll(px, 11, "proxied", undefined);
  console.log(px.weight, trace.join(","));
  // a revoked one throws
  const rv = Proxy.revocable(new First() as Node1, {});
  console.log(readAll(rv.proxy));
  rv.revoke();
  console.log(attempt(() => readAll(rv.proxy)), attempt(() => { rv.proxy.weight = 1; }));

  // null and undefined receivers: the generic path's TypeError
  console.log(attempt(() => readAll(null as unknown as Node1)), attempt(() => readAll(undefined as unknown as Node1)));
  console.log(attempt(() => writeAll(null as unknown as Node1, 1, "", undefined)));
  // primitives
  console.log(attempt(() => (5 as Loose).weight), attempt(() => ("str" as Loose).label), attempt(() => (true as unknown as Loose).next));
  console.log(attempt(() => { (5 as unknown as Node1).weight = 1; }));

  // integer slots through an interface, and a value that is not an integer left to the runtime's rule
  const ca = new CountA();
  const cb = new CountB();
  const cp: Counted = { count: 100 };
  ca.bump();
  console.log(addOne(ca), addOne(cb), addOne(cp), ca.count, cb.tag, ca.count === 2);

  // a union of ten subclasses of one base
  const many: Many[] = [new D1(), new D2(), new D3(), new D4(), new D5(), new D6(), new D7(), new D8(), new D9(), new D10()];
  console.log(many.map(kindOf).join(","));

  // other kinds of cells at sites that test classes
  console.log(lengthOf(new Len()), lengthOf([1, 2]), lengthOf("abcd"), lengthOf(new Uint8Array(5)), lengthOf(function (x: number, y: number) { return x + y; }));
  console.log(sizeOf(new Sz()), sizeOf(new Map([[1, 2], [3, 4], [5, 6]])), sizeOf(new Set([1])), sizeOf(new Blob(["abc"])));
  console.log(messageOf(new Msg()), messageOf(new RangeError("r")));
  // a symbol is no instance at such a site (what it reads there is a known gap, see the session note)
  descriptionOf(Symbol.for("registered") as unknown as HasDescription);
  descriptionOf(Symbol("local") as unknown as HasDescription);
  console.log(descriptionOf(new Desc()));
  console.log(hasNextType(new Nx()), hasNextType(gen()), hasNextType([1].values()), hasNextType(new Map([[1, 2]]).keys()));
  const rx = /a/g;
  setLastIndex(rx, 4);
  setLastIndex(new LastIdx(), 5);
  console.log(lastIndexOf(new LastIdx()), lastIndexOf(rx), rx.lastIndex);
  console.log(hasNextType(Promise.resolve(1) as unknown as HasNext), hasNextType(new Date(0) as unknown as HasNext), hasNextType(new WeakMap() as unknown as HasNext), hasNextType(new ArrayBuffer(1) as unknown as HasNext));
}

main();
