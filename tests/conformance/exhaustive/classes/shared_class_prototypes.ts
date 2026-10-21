// A module's class declarations run once: an instance's prototype is the
// class's `prototype` (one object), `instanceof` and `constructor` agree for
// instances made by `new`, by `Object.create(C.prototype)` and through
// subclasses, while classes evaluated again (in a function, a loop) get a
// prototype per evaluation; a class used before its declaration ran throws.
function early(): unknown { return new Late(); }
function earlyTest(x: unknown): boolean { return x instanceof Late; }
let earlyResult = "";
try { early(); } catch (e) { earlyResult = (e as Error).message; }
try { earlyTest({}); } catch (e) { earlyResult += " / " + (e as Error).constructor.name; }

class Base {
  tag = "base";
  describe(): string { return `${this.tag}:${this.constructor.name}`; }
}
class Child extends Base {
  extra = 1;
  describe(): string { return "child/" + super.describe(); }
}
const Expr = class Named extends Child { more = 2; };
class Late { v = 1; }
class WithHook {
  static [Symbol.hasInstance](x: unknown): boolean { return x === 42; }
}

function kinds(x: unknown): string {
  return [x instanceof Base, x instanceof Child, x instanceof Expr, x instanceof Late].map((b) => (b ? 1 : 0)).join("");
}
function fresh(): new () => { id: number } {
  return class { id = 7; };
}

function main(): void {
  const b = new Base(), c = new Child(), e = new Expr(), l = new Late();
  console.log(earlyResult, kinds(b), kinds(c), kinds(e), kinds(l), kinds({}), kinds(null));
  console.log(Object.getPrototypeOf(b) === Base.prototype, Object.getPrototypeOf(c) === Child.prototype,
    Object.getPrototypeOf(Child.prototype) === Base.prototype, Object.getPrototypeOf(e) === Expr.prototype);
  console.log(b.constructor === Base, c.constructor === Child, e.constructor === Expr, Base.prototype.constructor === Base);
  console.log(b.describe(), c.describe(), e.describe(), Expr.name);
  const made = Object.create(Child.prototype) as Child;
  console.log(kinds(made), made instanceof Base, made.describe === c.describe);
  (Base.prototype as unknown as { added: () => string }).added = () => "added";
  console.log((c as unknown as { added: () => string }).added(), Object.keys(Base.prototype).join(","));
  const K1 = fresh(), K2 = fresh();
  const k1 = new K1();
  console.log(k1 instanceof K1, k1 instanceof K2, Object.getPrototypeOf(k1) === K1.prototype, K1.prototype === K2.prototype);
  const perIteration: (new () => object)[] = [];
  for (let i = 0; i < 2; i++) { class Loop { i = i; } perIteration.push(Loop); }
  const li = new perIteration[0]();
  console.log(li instanceof perIteration[0], li instanceof perIteration[1], perIteration[0] === perIteration[1]);
  const Hook: any = WithHook;
  console.log(42 as unknown instanceof Hook, b instanceof Hook);
  let n = 0;
  const items: unknown[] = [b, c, e, l, made, {}, 3];
  for (let i = 0; i < 1000; i++) for (const x of items) if (x instanceof Child) n++;
  console.log(n);
}
main();
export {};
