// A dynamic call site's cache of its method: one site called with instances
// of several classes in turn; a prototype method replaced in place after the
// site has cached it; one deleted; an instance relinked to another prototype;
// a class prototype relinked; a sidecar property added after caching; a
// subclass whose field of the method's name holds a function (the site must
// keep looking the method up for that class); a getter in the method
// position; a receiver through `any` and through the class type.
class Base { m(): string { return "base"; } who(): string { return "B"; } }
class A extends Base { m(): string { return "A"; } }
class B extends Base { m(): string { return "B"; } }
class C extends Base { m(): string { return "C"; } }
class Other { m(): string { return "other"; } who(): string { return "O"; } }
class Fielded extends Base { m = (): string => "field"; }
class G { get m(): () => string { return () => "getter"; } who(): string { return "G"; } }
// the classes dispatch dynamically
(Base.prototype as any).who = function (this: Base): string { return "B'"; };
function callM(x: any): string { return x.m(); }
function callBase(b: Base): string { return b.m(); }
function main() {
  const out: unknown[] = [];
  const a = new A(), b = new B(), c = new C(), items: Base[] = [a, b, c, new Base()];
  for (let r = 0; r < 4; r++) for (const it of items) out.push(callM(it) + callBase(it));
  // replaced in place after the site cached it
  (A.prototype as any).m = function (this: A): string { return "A2"; };
  out.push(callM(a), callBase(a), callM(b));
  // deleted: the base's answers
  delete (B.prototype as any).m;
  out.push(callM(b), callBase(b));
  // an instance relinked
  Object.setPrototypeOf(c, Other.prototype);
  out.push(callM(c), callM(new C()));
  // a sidecar property added after caching, one of them shadowing the method
  (a as any).extra = 1; out.push(callM(a));
  (a as any).m = () => "own"; out.push(callM(a), callBase(a));
  // a field of the method's name
  const f = new Fielded(); out.push(callM(f), callBase(f)); (f as any).m = () => "field2"; out.push(callM(f), callBase(f));
  // a getter
  out.push(callM(new G()));
  // a class prototype relinked after caching
  const c2 = new C(); out.push(callM(c2)); Object.setPrototypeOf(C.prototype, Other.prototype); delete (C.prototype as any).m; out.push(callM(c2), callM(new C()), callM(new A()));
  let threw = ""; try { callM({}); } catch (e) { threw = (e as Error).constructor.name; } out.push(threw);
  console.log(JSON.stringify(out));
}
main();
