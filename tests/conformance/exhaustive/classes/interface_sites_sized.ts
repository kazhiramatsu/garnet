// A property read or written through an interface-typed receiver that class instances satisfy
// (vue's Subscriber, implemented by two classes) takes the inline cache that also probes the
// sized-receiver entries; the values must be those of the class instance, of a plain object that
// satisfies the same interface at the same site, of an accessor, an inherited method read as a
// value, a numeric field, a frozen instance and an instance with properties added at run time.
interface Sub { flags: number; deps?: Link; depsTail?: Link; name: string; notify(): string; }
interface Link { version: number; sub: Sub; nextDep?: Link; prevDep?: Link; }
class Effect implements Sub { flags = 1; deps?: Link = undefined; depsTail?: Link = undefined; constructor(public name: string) {} notify(): string { return "E:" + this.name; } get size(): number { return this.flags * 10; } }
class Computed implements Sub { flags = 2; deps?: Link = undefined; depsTail?: Link = undefined; name = "c"; private val = 0; notify(): string { return "C" + this.val++; } }
class Shape implements Sub { flags = 4; name = "s"; notify(): string { return "S"; } deps?: Link; depsTail?: Link; }
class LinkImpl implements Link { version = 0; nextDep?: Link = undefined; prevDep?: Link = undefined; constructor(public sub: Sub) {} }
function link(sub: Sub, l: Link): number {
  // reads and writes through the interface: the receiver alternates between classes and literals
  l.sub = sub; l.version = sub.flags + 1;
  const tail = sub.depsTail;
  if (tail) { tail.nextDep = l; l.prevDep = tail; } else sub.deps = l;
  sub.depsTail = l;
  sub.flags = sub.flags | 8;
  return l.version + (l.prevDep ? l.prevDep.version : 0);
}
function count(sub: Sub): string {
  let n = 0, s = "";
  for (let l = sub.deps; l !== undefined; l = l.nextDep) { n++; s += l.version; }
  return n + ":" + s + ":" + sub.notify() + ":" + sub.name;
}
function main(): void {
  const subs: Sub[] = [new Effect("e1"), new Computed(), { flags: 16, name: "lit", notify() { return "L"; } }, new Shape(), new Effect("e2")];
  const total: number[] = [];
  for (let round = 0; round < 3; round++)
    for (const sub of subs) total.push(link(sub, round % 2 === 0 ? new LinkImpl(sub) : { version: -1, sub }));
  console.log(total.join(","));
  console.log(subs.map(count).join(" | "));
  console.log(subs.map((s) => s.flags).join(","), (subs[0] as Effect).size, (subs[2] as any).size);
  // an accessor and an inherited method value through the interface-typed site
  const withAcc: Sub = new Effect("acc");
  const f = withAcc.notify; console.log(typeof f, f.call(withAcc), withAcc.notify());
  // a frozen instance refuses the write (strict mode: a TypeError)
  const frozen: Sub = Object.freeze(new Effect("fz"));
  try { frozen.flags = 99; } catch (e) { console.log((e as Error).constructor.name, frozen.flags); }
  // properties added at run time keep the struct fields where they are
  const dyn = new Effect("dyn"); (dyn as any).extra = "x"; const dynSub: Sub = dyn;
  dynSub.flags = 32; console.log(dynSub.flags, (dynSub as any).extra, dynSub.name, Object.keys(dyn).sort().join(","));
  // a union of classes and a type parameter constrained by the interface
  function flagsOf<T extends Sub>(s: T): number { s.flags += 1; return s.flags; }
  const u: Effect | Computed = Math.random() < 2 ? new Computed() : new Effect("never");
  console.log(flagsOf(u), flagsOf(new Effect("t")), flagsOf({ flags: 7, name: "o", notify: () => "" }), u.flags);
}
main();
