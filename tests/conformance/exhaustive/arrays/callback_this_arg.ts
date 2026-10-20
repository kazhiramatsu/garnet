// The thisArg of the iteration methods (`arr.forEach(fn, ctx)`), on typed
// receivers and through `any` (dynamic dispatch), for Map / Set forEach, with
// an arrow callback (thisArg has no effect) and an undefined thisArg; and
// reduce / reduceRight of an empty (or all-holes) array without an initial
// value, which throws a TypeError.
interface Ctx { k: number; tag: string; }
function main(): void {
  const ctx: Ctx = { k: 10, tag: "c" };
  const arr = [1, 2, 3];
  const out: string[] = [];
  arr.forEach(function (this: Ctx, x: number) { out.push(this.tag + (this.k + x)); }, ctx);
  const m = arr.map(function (this: Ctx, x: number) { return this.k * x; }, ctx);
  const f = arr.filter(function (this: Ctx, x: number) { return x * this.k > 15; }, ctx);
  const s = arr.some(function (this: Ctx, x: number) { return this.k === 10 && x === 2; }, ctx);
  const e = arr.every(function (this: Ctx, x: number) { return this.k > x; }, ctx);
  const fd = arr.find(function (this: Ctx, x: number) { return x + this.k === 12; }, ctx);
  const fi = arr.findIndex(function (this: Ctx, x: number) { return x + this.k === 13; }, ctx);
  const fl = arr.findLast(function (this: Ctx, x: number) { return x < this.k; }, ctx);
  const fli = arr.findLastIndex(function (this: Ctx, x: number) { return x === this.k - 9; }, ctx);
  const fm = arr.flatMap(function (this: Ctx, x: number) { return [x, this.k]; }, ctx);
  const arrow = arr.map((x) => typeof this + x, ctx);
  const undef = arr.map(function (this: unknown, x: number) { return typeof this + x; }, undefined);
  const map = new Map<string, number>([["a", 1]]);
  map.forEach(function (this: Ctx, v: number, k: string) { out.push(k + (v + this.k)); }, ctx);
  const set = new Set<number>([7]);
  set.forEach(function (this: Ctx, v: number) { out.push(String(v * this.k)); }, ctx);
  const dyn: any = arr;
  const dm = dyn.map(function (this: Ctx, x: number) { return x - this.k; }, ctx);
  const dfe: number[] = []; dyn.forEach(function (this: Ctx, x: number) { dfe.push(x + this.k); }, ctx);
  console.log(out.join(","), m.join(","), f.join(","), s, e, fd, fi, fl, fli, fm.join(","), arrow.join(","), undef.join(","), dm.join(","), dfe.join(","));
  const empty: number[] = [];
  const holes: number[] = [, , ,] as any;
  for (const run of [() => empty.reduce((a, b) => a + b), () => empty.reduceRight((a, b) => a + b), () => holes.reduce((a, b) => a + b)]) {
    try { console.log(run()); } catch (err) { console.log((err as Error).constructor.name, (err as Error).message); }
  }
  console.log([5].reduce((a, b) => a + b), empty.reduce((a, b) => a + b, 7), [1, 2].reduceRight((a, b) => a * 10 + b));
}
main();
