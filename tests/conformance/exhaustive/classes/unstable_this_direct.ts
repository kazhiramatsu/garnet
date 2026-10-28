// A method's `this` of a class the structural flow pass made unstable (an `any` typed as the class)
// reads and writes its declared fields directly (Session 356, docs/hidden_class_design.md S0): every
// way a foreign `this` can reach the method must still read through the generic path — a borrowed
// method (`call`), an `Object.create(C.prototype)` receiver, a relinked instance, a plain object typed
// as the class whose own method is called, a subclass instance, an instance of another class.
class Dep {
  version = 0;
  key: string;
  computed: any = undefined;
  constructor(key: string) { this.key = key; }
  bump(n: number) { this.version += n; return this.version; }
  describe() { return this.key + ":" + this.version + ":" + (this.computed === undefined ? "-" : String(this.computed)); }
}
class SubDep extends Dep {
  extra = 7;
  describe() { return "sub(" + super.describe() + "," + this.extra + ")"; }
}
class Link { version = 100; key = "link"; computed = 1; next: any = null; }
const map = new Map();   // Map<any, any>: an `any` flows into the Dep-typed binding below
function lookup(k: string): Dep { let d = map.get(k); if (!d) map.set(k, (d = new Dep(k))); return d; }
function main() {
  const out: string[] = [];
  const d = lookup("a"); d.bump(2); d.computed = "c";
  const s = new SubDep("s"); s.bump(3);
  out.push(d.describe(), s.describe(), String(d.bump(1)), String(s.bump(1)));
  // a borrowed method on an instance of another class and on a plain object
  const l: any = new Link();
  out.push(String(Dep.prototype.bump.call(l, 5)), Dep.prototype.describe.call(l));
  const plain: any = { version: 40, key: "plain", computed: null };
  out.push(String(Dep.prototype.bump.call(plain, 2)), Dep.prototype.describe.call(plain));
  // Object.create(Dep.prototype): a non-instance whose chain holds the methods
  const oc: any = Object.create(Dep.prototype); oc.version = 10; oc.key = "oc";
  out.push(String(oc.bump(1)), oc.describe());
  // a plain object typed as Dep through the map, with methods of its own (type-honest: typed mode
  // trusts the declared return types, CLAUDE.md known items)
  map.set("fake", { version: 1, key: "fake", computed: 0, bump(n: number) { return 1000 + n; }, describe() { return "fake-describe"; } });
  const f = lookup("fake");
  out.push(String(f.bump(9)), f.describe());
  // a relinked instance: its methods now come from Link's chain (none), so only the fields read
  const r: any = new Dep("r"); Object.setPrototypeOf(r, Link.prototype);
  out.push(String(r.version), String(r.key), typeof r.bump);
  // the instances again after all of that
  out.push(d.describe(), s.describe(), String(lookup("a") === d));
  console.log(out.join("\n"));
}
main();
