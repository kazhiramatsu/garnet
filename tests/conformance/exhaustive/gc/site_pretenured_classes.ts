// Allocation-site pretenuring (docs/site_pretenuring_design.md): a site whose
// class instances survive their first collection allocates them old. Their
// fields then take young values through the barrier, a class evaluated in a
// function hands its young prototype to old instances, and a site whose
// instances stop surviving goes back to young.
class Named {
  name: string;
  tags: string[];
  peer: Named | null = null;
  meta: { idx: number; label: string } | null = null;
  constructor(name: string) { this.name = name; this.tags = []; }
}
class Point { constructor(public x: number, public y: number) {} }
class Base {
  kind = "base";
  constructor(public id: number) {}
  describe(): string { return this.kind + ":" + this.id; }
}
class Derived extends Base {
  extra: { n: number }[];
  constructor(id: number) { super(id); this.kind = "derived"; this.extra = [{ n: id }]; }
  describe(): string { return super.describe() + "+" + this.extra[0].n; }
}
class Rec { constructor(public k: number, public s: string) {} }

// Short-lived instances from a site of their own (a ring keeps them on the heap).
const ring: Point[] = [];
function churn(n: number, seed: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const p = new Point(i, i + seed);
    ring[i & 63] = p;
    acc += p.y - p.x;
  }
  return acc;
}

// Allocations returned from factories: no static strategy claims them, so
// their sites decide by survival.
function named(i: number): Named { return new Named("n" + i); }

// 1. long-lived instances: the site tenures after its first collections
const kept: Named[] = [];
for (let i = 0; i < 80000; i++) kept.push(named(i));
let churned = churn(200000, 1);

// 2. old instances take young values after the fact
for (let i = 0; i < kept.length; i++) {
  const n = kept[i];
  n.tags.push("t" + (i % 13));
  n.peer = kept[(i * 7) % kept.length];
  n.meta = { idx: i, label: "m" + i };
  if (i % 5 === 0) (n as any)["dyn" + (i % 3)] = [i, "d" + i];
}
churned += churn(200000, 2);
let check1 = 0;
for (let i = 0; i < kept.length; i++) {
  const n = kept[i];
  check1 += n.name.length + n.tags[0].length + (n.peer ? n.peer.name.length : 0);
  check1 += n.meta!.idx + n.meta!.label.length;
  const d = (n as any)["dyn" + (i % 3)];
  if (i % 5 === 0) check1 += d[0] + d[1].length;
}
console.log("named", check1, churned);

// 3. a class evaluated per call: each evaluation's prototype starts young
function localInstances(k: number, count: number): { twice(): number }[] {
  class Local {
    constructor(public v: number, public k: number) {}
    twice(): number { return this.v * 2 + this.k; }
  }
  const make = (j: number): Local => new Local(j, k);
  const out: Local[] = [];
  for (let j = 0; j < count; j++) out.push(make(j));
  return out;
}
const locals: { twice(): number }[][] = [];
for (let k = 0; k < 60; k++) locals.push(localInstances(k, 1500));
churned += churn(200000, 3);
let check2 = 0;
for (const group of locals) for (const l of group) check2 += l.twice();
console.log("locals", check2, locals.length);

// 4. subclasses through tenured sites
function shape(i: number): Base { return i % 2 ? new Derived(i) : new Base(i); }
const shapes: Base[] = [];
for (let i = 0; i < 40000; i++) shapes.push(shape(i));
churned += churn(200000, 4);
for (let i = 0; i < shapes.length; i += 2) shapes[i].kind = "re" + (i % 7);
let check3 = 0;
for (const s of shapes) check3 += s.describe().length + (s instanceof Derived ? s.extra[0].n : 0);
console.log("shapes", check3);

// 5. a phase change: the site's records lived, then they die
function rec(k: number): Rec { return new Rec(k, "r" + (k % 31)); }
const recs: Rec[] = [];
for (let i = 0; i < 100000; i++) recs.push(rec(i));
let recSum = 0;
for (let i = 0; i < 600000; i++) { const r = rec(i); recSum += r.s.length + (r.k & 1); }
let check4 = 0;
for (const r of recs) check4 += r.k + r.s.length;
console.log("recs", check4, recSum, churned);
let tail = 0;
for (const n of kept) tail += n.name.length;
for (const g of locals) tail += g.length;
for (const s of shapes) tail += s.id;
console.log("tail", tail);
