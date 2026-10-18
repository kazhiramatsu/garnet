// A collection-free leaf keeps its root frame unlinked; a property read whose
// slow path runs a getter must link it, or a local that the getter detaches
// from every other root is collected under it.
interface Holder { a: { v: number } | null; readonly trigger: number; n: number; }
let garbage: number[][] = [];
function makeHolder(i: number): Holder {
  const h = {
    a: { v: i },
    n: i,
    get trigger(): number {
      // detach `a` from the holder and allocate enough to force collections
      const a = this.a; this.a = null;
      for (let k = 0; k < 64; k++) garbage.push([k, k + 1, k + 2]);
      if (garbage.length > 4096) garbage = [];
      return a ? 1 : 0;
    },
  };
  return h as unknown as Holder;
}
// collection-free: property reads only (the getter is reached through the
// inline-cache slow path), arithmetic on numbers
function leaf(o: Holder): number {
  const a = o.a;
  const t = o.trigger;
  const n = o.n;
  return (a ? a.v : -1) + t + n;
}
function main(): void {
  let sum = 0;
  for (let i = 0; i < 3000; i++) sum += leaf(makeHolder(i));
  console.log(sum, garbage.length > 0);
}
main();
