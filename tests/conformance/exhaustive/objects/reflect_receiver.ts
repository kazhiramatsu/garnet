// Reflect.get / Reflect.set with a receiver: getters and setters found on the
// target's chain run with the receiver as `this`, a writable data property
// leaves the write to the receiver (its own property), read-only and
// accessor cases fail with false instead of throwing.
class Pt { x = 1; y = 2; }
function main(): void {
  const log: string[] = [];
  const base: any = {
    plain: 10,
    get g() { return "g:" + (this as any).name; },
    set s(v: number) { log.push("s:" + (this as any).name + "=" + v); },
  };
  Object.defineProperty(base, "ro", { value: 7, writable: false, enumerable: true, configurable: true });
  const t: any = Object.create(base);
  t.name = "t";
  const r: any = { name: "r" };

  console.log(Reflect.get(t, "g", r), Reflect.get(t, "plain", r), Reflect.get(t, "missing", r), Reflect.get(t, "g"));
  console.log(Reflect.set(t, "s", 5, r), log.join(","));
  console.log(Reflect.set(t, "plain", 11, r), r.plain, t.plain, base.plain, Object.keys(r).join(","));
  console.log(Reflect.set(t, "fresh", 1, r), r.fresh, t.fresh);
  console.log(Reflect.set(t, "ro", 8, r), r.ro, Object.keys(r).join(","));
  const withAcc: any = {};
  Object.defineProperty(withAcc, "plain", { get() { return 0; }, configurable: true });
  console.log(Reflect.set(t, "plain", 12, withAcc), withAcc.plain);
  const frozen: any = Object.freeze({ plain: 1 });
  console.log(Reflect.set(t, "plain", 13, frozen), frozen.plain);
  const sealedNew: any = Object.preventExtensions({ name: "p" });
  console.log(Reflect.set(t, "brandNew", 1, sealedNew), sealedNew.brandNew);
  console.log(Reflect.set(t, "plain", 14), t.plain, base.plain);

  // class instances: declared fields of the receiver and of the target
  const p = new Pt();
  console.log(Reflect.set(t, "x", 30, p), p.x, Reflect.get(p, "y", r), Reflect.get(t, "g", p));
  const q = new Pt();
  console.log(Reflect.set(q, "x", 40, r), q.x, r.x);

  // a loop at one site with alternating receivers
  let acc = "";
  for (let i = 0; i < 6; i++) acc += Reflect.get(t, "g", (i & 1) ? r : t) + ";";
  console.log(acc);
}
main();
