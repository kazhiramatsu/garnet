// A class without a constructor runs its field initializers at each `new` site, in the
// caller's scope: an arrow initializer that uses `this` (`handler = () => this.x`) must capture
// that site's instance, not the enclosing function's `this` nor the instance of an earlier `new`
// in the same block (two `new C()` in one block gave the second instance's arrows the first
// instance). Sites in a method, in an arrow (whose own lexical this is inherited), at module
// level, in a loop, nested in an expression, and an arrow of the enclosing method created after
// the `new` sites still sees the method's `this`.
class C { n = 0; get = () => this.n; bump = () => { this.n++; return this.n; }; }
class D { tag = "d"; inner = new C(); peek = () => this.tag + ":" + this.inner.get(); }
class E { x: number; f = () => this.x; constructor(x: number) { this.x = x; } }
class Host {
  id = "host";
  make(): string[] {
    const a = new C(); a.n = 1;
    const b = new C(); b.n = 2;
    const c = a.n > 0 ? new C() : new C(); c.n = 3;
    const mine = () => this.id;
    const d1 = new D(); d1.inner.n = 10; const d2 = new D(); d2.tag = "d2"; d2.inner.n = 20;
    return [String(a.get()), String(b.get()), String(c.get()), mine(), d1.peek(), d2.peek(), String(a.bump()), String(b.bump()), String(b.get())];
  }
  makeArrow = (): string[] => {
    const a = new C(); a.n = 4;
    const b = new C(); b.n = 5;
    const mine = () => this.id;
    return [String(a.get()), String(b.get()), mine()];
  };
}
const top1 = new C(); top1.n = 6;
const top2 = new C(); top2.n = 7;
function main() {
  const out: string[] = [];
  out.push(...new Host().make(), ...new Host().makeArrow(), String(top1.get()), String(top2.get()));
  const many: C[] = [];
  for (let i = 0; i < 3; i++) { const c = new C(); c.n = i; many.push(c); }
  out.push(many.map((c) => String(c.get())).join(","));
  const e1 = new E(1), e2 = new E(2); out.push(String(e1.f()), String(e2.f()));
  const h = new Host(); const first = h.makeArrow; h.id = "changed"; out.push(first()[2], new Host().makeArrow()[2]);
  console.log(JSON.stringify(out));
}
main();
