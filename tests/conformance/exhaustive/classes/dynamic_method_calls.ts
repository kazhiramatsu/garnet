// Method calls on instances of classes that dispatch dynamically: prototype
// methods through base-typed, subclass-typed and `any` receivers; a field
// holding a function that shadows a prototype method; an own property added
// later that shadows one; a prototype method replaced in place and one
// deleted (the lookup must follow); a getter in the method position; `this.m()`
// and `super.m()` inside methods; one call site over many classes; a frozen
// prototype; a receiver relinked to another prototype; null receivers.
class Base { v = 1; m(k: number): number { return this.v + k; } name(): string { return "base"; } get g(): () => string { return () => "getter"; } }
class Sub extends Base { m(k: number): number { return super.m(k) * 10; } name(): string { return "sub<" + super.name() + ">"; } }
class Fielded extends Base { m = (k: number): number => -k; }
class Many0 extends Base { name(): string { return "m0"; } }
class Many1 extends Base { name(): string { return "m1"; } }
class Many2 extends Base { name(): string { return "m2"; } }
class Many3 extends Base { name(): string { return "m3"; } }
class Many4 extends Base { name(): string { return "m4"; } }
class Many5 extends Base { name(): string { return "m5"; } }
// the classes dispatch dynamically
Base.prototype.name = function (this: Base): string { return "base'"; };
function callName(x: any): string { return x.name(); }
function callM(x: any, k: number): number { return x.m(k); }
function main() {
  const out: unknown[] = [];
  const items: Base[] = [new Base(), new Sub(), new Fielded(), new Many0(), new Many1(), new Many2(), new Many3(), new Many4(), new Many5()];
  for (let round = 0; round < 3; round++) for (const it of items) out.push(callName(it) + ":" + callM(it, round));
  const s = new Sub(); out.push(s.m(1), s.name(), (s as any).m(2), (s as any).g());
  // an own property added later shadows the prototype method
  const b = new Base() as any; b.name = () => "own"; out.push(callName(b), b.name(), callM(b, 5));
  // a prototype method replaced in place: every receiver follows
  (Many2.prototype as any).name = function (this: Many2): string { return "m2'"; };
  out.push(callName(items[5]), callName(new Many2()));
  // a prototype method deleted: the base's answers
  delete (Many3.prototype as any).name;
  out.push(callName(items[6]));
  // a receiver relinked to another prototype
  const r = new Many4(); Object.setPrototypeOf(r, Many5.prototype); out.push(callName(r), callM(r, 1));
  // a frozen prototype still dispatches
  Object.freeze(Many1.prototype); out.push(callName(items[4]));
  let threw = ""; try { callName(null); } catch (e) { threw = (e as Error).constructor.name; } out.push(threw);
  let threw2 = ""; try { (new Base() as any).nope(); } catch (e) { threw2 = (e as Error).constructor.name; } out.push(threw2);
  console.log(JSON.stringify(out));
}
main();
