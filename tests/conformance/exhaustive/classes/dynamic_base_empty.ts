// `class D extends Parent {}` where Parent is a runtime value: a const holding Error or TypeError, a user
// class, a plain constructor function, a class expression value, and a derived class again. The base
// builds the instance (an Error has its message and name and is an instance of both), the prototype
// chain and the statics chain follow the base, the derived constructor's name and length,
// Object.defineProperty of its name (zod's $constructor idiom), and a throw caught by the derived type.
class Base { kind = "base"; greet(): string { return "hi " + this.kind; } static tag(): string { return "B"; } }
function Legacy(this: any, v: number) { this.v = v; }
function derive(Parent: any, name: string): any {
  class Definition extends Parent {}
  Object.defineProperty(Definition, "name", { value: name });
  return Definition;
}
function main(): void {
  const out: string[] = [];
  const E = derive(Error, "MyErr");
  const e = new E("boom");
  out.push(String(e instanceof Error), String(e instanceof E), e.message, e.name, String(Object.getPrototypeOf(e) === E.prototype),
    String(Object.getPrototypeOf(E.prototype) === Error.prototype), E.name, String(E.length));
  const TE = derive(TypeError, "MyTypeErr");
  const te = new TE("bad");
  out.push(String(te instanceof TypeError), String(te instanceof Error), te.name, String(TE.name));
  const B2 = derive(Base, "B2");
  const b = new B2();
  out.push(b.greet(), String(b instanceof Base), String(b instanceof B2), String(B2.tag()), String(Object.getPrototypeOf(B2) === Base));
  const L2 = derive(Legacy, "L2");
  const l = new L2(7);
  out.push(String(l.v), String(l instanceof L2), String(Object.getPrototypeOf(l) === L2.prototype));
  const K = class { x = 1; };
  const K2 = derive(K, "K2");
  out.push(String(new K2().x), String(new K2() instanceof K));
  const AB = derive(derive(Error, "A"), "AB");
  const c = new AB("deep");
  out.push(String(c instanceof Error), c.message, String(Object.getPrototypeOf(Object.getPrototypeOf(c)) !== Error.prototype));
  try { throw new E("thrown"); } catch (err) { out.push(err instanceof E ? "caught " + (err as Error).message : "wrong"); }
  console.log(out.join("\n"));
}
main();
