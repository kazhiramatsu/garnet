// Branch-aware inlining of small free functions: early returns, nested
// branches, captured cells, missing arguments, void paths, unused results.
interface T { flags: number; objectFlags: number; name?: string; next?: T }
function getObjectFlags(t: T): number { return t.flags & 1 ? t.objectFlags : 0; }
function early(x: number): number { if (x > 1) return 2; return 3; }
function nested(x: number, y: number): number {
  if (x > 0) { if (y > 0) return 1; return 2; }
  if (y > 0) return 3;
  return 4;
}
function maybeVoid(t: T): void { if (t.flags) { return; } t.name = "set"; }
function optional(a: number, b?: number): number { return b === undefined ? a : a + b; }
function label(t: T): string { if (t.name !== undefined) return t.name; return "anon"; }
function partial(x: number): number | undefined { if (x > 5) return x * 2; }
function twice(a: number, b: number): number { if (a === b) return a + b; return a - b; }
function chain(t: T): T | undefined { if (t.next) { if (t.next.next) return t.next.next; return t.next; } return undefined; }
function setBoth(t: T, v: number): void { if (v > 0) { t.flags = v; t.objectFlags = v * 10; } else { t.flags = 0; } }
function main(): void {
  const a: T = { flags: 1, objectFlags: 5 };
  const b: T = { flags: 2, objectFlags: 7, name: "b" };
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    acc += getObjectFlags(i % 2 ? a : b) + early(i) + nested(i - 1, 2 - i) + optional(i) + optional(i, i);
  }
  console.log(acc, getObjectFlags(a) & 4, early(0), nested(1, 1), nested(-1, 1), nested(-1, -1));
  maybeVoid(a); maybeVoid({ flags: 0, objectFlags: 0 });
  const z: T = { flags: 0, objectFlags: 0 }; maybeVoid(z);
  console.log(a.name, z.name, label(a), label(b), partial(3), partial(9), twice(2, 2), twice(5, 2));
  a.next = b; b.next = z;
  console.log(chain(a) === z, chain(b) === z, chain(z) === undefined);
  let r: any = 7;
  for (let i = 0; i < 3; i++) { r = partial(i * 4); console.log(r); }
  early(9); nested(0, 0);
  setBoth(z, 3); setBoth(a, -1);
  console.log(z.flags, z.objectFlags, a.flags, a.objectFlags);
  // a nested declaration with a captured variable and branches
  let count = 0;
  function bump(n: number): number { if (n > 2) { count += n; return count; } count += 1; return -count; }
  console.log(bump(1), bump(5), bump(0), count);
}
main();
