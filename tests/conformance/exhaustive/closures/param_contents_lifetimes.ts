// Lifetime attacks on the escape analysis (docs/escape_param_contents_design.md):
// an object, array or closure that a function stores THROUGH a parameter's
// contents outlives the call, so it must not be stack-allocated. Every store
// path below is read back after enough allocation to force collections:
// one load deep (reg.list.push), two loads deep (h.reg.list.push), an element
// of a parameter array (slots[0].list), an opaque return value
// (getHolder().reg.list), a module-level object, `this` in a method, a closure
// stored on a parameter's field, a closure retained through an inner closure
// that an opaque helper stores, a closure returned inside a fresh object, a
// dynamic-key store read back by a named load, and a callback that is only
// called (never retained).
class Box { constructor(public v: number) {} }
interface Registry { list: Box[]; cbs: (() => number)[]; arrays: number[][]; onDone?: () => number; }
interface Holder { reg: Registry; }
function newRegistry(): Registry { return { list: [], cbs: [], arrays: [] }; }
const holder: Holder = { reg: newRegistry() };
const moduleReg: Registry = newRegistry();
const retained: (() => number)[] = [];
function getHolder(): Holder { return holder; }
function keep(cb: () => number): void { retained.push(cb); }
function callOnly(cb: (x: number) => number, x: number): number { return cb(x); }
function oneDeep(reg: Registry, i: number): void {
  const b = new Box(i);
  reg.list.push(b);
  const cb = () => b.v + i;
  reg.cbs.push(cb);
  reg.arrays.push([i, i + 1]);
  const lit = { v: i * 10 };
  reg.list.push(lit as Box);
}
function twoDeep(h: Holder, i: number): void {
  const b = new Box(i * 2);
  h.reg.list.push(b);
  const cb = () => b.v * 2;
  h.reg.cbs.push(cb);
}
function viaElement(slots: Registry[], i: number): void {
  const b = new Box(i * 3);
  slots[0].list.push(b);
  slots[0].cbs.push(() => b.v * 3);
}
function viaOpaque(i: number): void {
  const b = new Box(i * 4);
  getHolder().reg.list.push(b);
  getHolder().reg.cbs.push(() => b.v * 4);
}
function viaModule(i: number): void {
  const b = new Box(i * 5);
  moduleReg.list.push(b);
  moduleReg.cbs.push(() => b.v * 5);
}
class Collector {
  items: Box[] = [];
  add(i: number): void { const b = new Box(i * 6); this.items.push(b); }
}
function onField(reg: Registry, i: number): void {
  const b = new Box(i * 7);
  reg.onDone = () => b.v;            // closure stored on a parameter's field
}
function throughInner(i: number): void {
  const b = new Box(i * 8);
  const cb = () => b.v;
  const inner = () => cb() + 1;      // inner closure captures cb
  keep(inner);                       // retained by an opaque helper
}
function returnedInside(i: number): { run: () => number } {
  const b = new Box(i * 9);
  return { run: () => b.v };
}
function dynamicKey(reg: Registry, i: number): void {
  const b = new Box(i * 11);
  (reg as any)["list"] = [];
  reg.list.push(b);                  // named load after a dynamic store
}
function onlyCalled(i: number): number {
  const b = new Box(i);
  return callOnly(x => x + b.v, 1);  // never retained
}
function churn(): void { for (let i = 0; i < 300000; i++) { const t = new Box(i); if (t.v < 0) console.log(t.v); } }
function sum(reg: Registry): number {
  let s = 0;
  for (const b of reg.list) s += b.v;
  for (const cb of reg.cbs) s += cb();
  for (const a of reg.arrays) s += a[0] + a[1];
  return s + (reg.onDone ? reg.onDone() : 0);
}
function main(): void {
  const reg = newRegistry();
  const slots = [reg];
  const coll = new Collector();
  const runs: { run: () => number }[] = [];
  let direct = 0;
  for (let i = 0; i < 40; i++) {
    oneDeep(reg, i); twoDeep(holder, i); viaElement(slots, i); viaOpaque(i); viaModule(i);
    coll.add(i); onField(reg, i); throughInner(i); runs.push(returnedInside(i)); direct += onlyCalled(i);
  }
  churn();
  let s = 0;
  for (const b of coll.items) s += b.v;
  for (const cb of retained) s += cb();
  for (const r of runs) s += r.run();
  console.log(sum(reg), sum(holder.reg), sum(moduleReg), s, direct, reg.list.length, holder.reg.cbs.length);
  const reg2 = newRegistry();
  dynamicKey(reg2, 1); dynamicKey(reg2, 2);
  churn();
  console.log(reg2.list.length, reg2.list[0].v, sum(reg2));
}
main();
