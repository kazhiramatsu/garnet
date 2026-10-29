// A member-less class over a runtime value whose value is a class with fields (a mixin's
// `class extends b {}`, an `any` alias of a class, a call returning one): the instance is the base's,
// with its fields visible to enumeration (Object.keys, JSON.stringify, for..in, own names), not only
// to reads; the derived prototype chain and instanceof hold; a nested mixin too. The derived
// constructor relinked the instance's prototype with the raw setter, which lost the fields' layout
// registration (Session 358).
class A { a = 1; b = "two"; c: number; constructor(c: number = 3) { this.c = c; } hello(): string { return "A" + this.a; } }
function mix<B extends new (...args: any[]) => object>(b: B) { return class extends b {}; }
class M extends mix(A) {}
const Alias: any = A;
class D extends Alias {}
function pick(): typeof A { return A; }
class E extends pick() {}
const Twice = mix(mix(A));
function main(): void {
  for (const [name, inst] of [["M", new M(7)], ["D", new D(8)], ["E", new E(9)], ["Twice", new Twice(10)]] as [string, A][]) {
    const forIn: string[] = [];
    for (const k in inst) forIn.push(k);
    console.log(name, JSON.stringify(inst), Object.keys(inst), forIn, Object.getOwnPropertyNames(inst), inst.a, inst.c, inst.hello(), inst instanceof A);
  }
  console.log(new M(1) instanceof M, Object.getPrototypeOf(M.prototype) === A.prototype, Object.getPrototypeOf(new Twice()) === Twice.prototype);
}
main();
