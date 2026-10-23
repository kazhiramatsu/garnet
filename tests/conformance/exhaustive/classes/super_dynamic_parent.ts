// `super.m()` when a class on the path from the parent to the declaring class
// is dynamic: the lookup must follow the prototype at run time. A parent
// method replaced before and after instances exist; a grandparent's method
// replaced where the parent does not declare it; the subclass's prototype
// relinked to another class's; a super call inside a getter; `this` inside the
// replacement is the receiver. (A class declared inside a function keeps the
// static resolution, and `super` inside an arrow function is a loud reject:
// docs/conformance_fixes.md.)
class Grand { who(): string { return "grand"; } tag(): string { return "G"; } }
class Base extends Grand { v = 5; m(k: number): number { return this.v + k; } who(): string { return "base"; } }
class Sub extends Base {
  m(k: number): number { return super.m(k) * 100; }
  who(): string { return "sub(" + super.who() + ")"; }
  tag(): string { return "S" + super.tag(); }
  get viaGetter(): string { return super.who() + "!"; }
}
class Other { who(): string { return "other"; } m(k: number): number { return -k; } tag(): string { return "O"; } }
class Leaf extends Sub { who(): string { return "leaf:" + super.who(); } }
Base.prototype.m = function (this: Base, k: number): number { return this.v * 1000 + k; };
Grand.prototype.tag = function (this: Grand): string { return "G'"; };
function main() {
  const out: unknown[] = [];
  const s = new Sub();
  out.push(s.m(1), s.who(), s.tag(), s.viaGetter);
  // replaced after instances exist: every receiver follows
  (Base.prototype as any).who = function (this: Base): string { return "base*" + this.v; };
  out.push(s.who(), new Sub().who(), new Leaf().who(), new Leaf().m(2));
  // the subclass's prototype relinked: super reads the new parent
  Object.setPrototypeOf(Sub.prototype, Other.prototype);
  out.push(s.who(), s.m(3), s.tag());
  console.log(JSON.stringify(out));
}
main();
