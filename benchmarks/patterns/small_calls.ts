// Per-call overhead: tiny helpers taking object arguments (getObjectFlags-like).
interface T { flags: number; objectFlags: number; id: number; }
function getObjectFlags(t: T): number { return t.flags & 524288 ? t.objectFlags : 0; }
function isRef(t: T): boolean { return (getObjectFlags(t) & 4) !== 0; }
function idOf(t: T): number { return t.id; }
function pick(a: T, b: T): T { return a.id < b.id ? a : b; }
function main(): void {
  const ts: T[] = []; for (let i = 0; i < 1024; i++) ts.push({ flags: (i & 1) ? 524288 : 0, objectFlags: i & 7, id: i });
  let sum = 0;
  for (let r = 0; r < 160000; r++) for (let i = 0; i < 1024; i++) { const t = ts[i];
    if (isRef(t)) sum += idOf(pick(t, ts[(i + 1) & 1023])); else sum += getObjectFlags(t); }
  console.log(sum);
}
main();
