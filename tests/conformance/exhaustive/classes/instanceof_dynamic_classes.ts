// `instanceof` against classes that dispatch dynamically: a prototype method
// replaced and a method deleted (the chain unchanged), an instance relinked
// to another prototype, a class prototype relinked, subclass chains, a
// constructor returning another object, plain objects and primitives, and a
// class declared inside a function. (A class's `prototype` property is not
// writable: reassigning it throws in V8 and here alike.)
class Base { m(): string { return "base"; } }
class Mid extends Base { m(): string { return "mid"; } }
class Leaf extends Mid {}
class Other { m(): string { return "other"; } }
class Swapped { m(): string { return "swapped"; } }
class Returning { constructor() { return new Other() as unknown as Returning; } }
class Elem { tag = "e"; }
// the classes dispatch dynamically
(Base.prototype as any).m = function (this: Base): string { return "base'"; };
(Elem.prototype as any)["x" + "y"] = 1;
function makeLocal(n: number): object[] {
  class L { constructor(public n: number) {} }
  const out: object[] = []; for (let i = 0; i < n; i++) out.push(new L(i)); return out;
}
function check(x: unknown): string {
  return [x instanceof Base, x instanceof Mid, x instanceof Leaf, x instanceof Other, x instanceof Swapped, x instanceof Returning, x instanceof Elem]
    .map((b) => (b ? "1" : "0")).join("");
}
function main() {
  const out: string[] = [];
  const b = new Base(), m = new Mid(), l = new Leaf(), o = new Other(), s = new Swapped(), r = new Returning(), e = new Elem();
  const items: unknown[] = [b, m, l, o, s, r, e, {}, null, undefined, 3, "s", Base, Object.create(Mid.prototype), ...makeLocal(2)];
  for (let round = 0; round < 3; round++) for (const it of items) out.push(check(it));
  // a method replaced in place and one deleted: the chain is unchanged
  (Swapped.prototype as any).m = function (this: Swapped): string { return "swapped2"; };
  delete (Elem.prototype as any)["xy"];
  out.push(check(s), check(new Swapped()), s.m(), check(e));
  // an instance relinked
  Object.setPrototypeOf(m, Other.prototype);
  out.push(check(m), check(new Mid()));
  // a class prototype relinked: every Leaf is an Other now and no Mid
  Object.setPrototypeOf(Leaf.prototype, Other.prototype);
  out.push(check(l), check(new Leaf()), check(new Mid()));
  console.log(JSON.stringify(out));
}
main();
