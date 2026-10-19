// A binding assigned after its declaration still travels by value when every
// assignment precedes every capturing closure; anything assigned later, assigned
// inside a closure, or re-assigned in a loop shared with a capture stays shared.
function every<T>(xs: T[], f: (x: T) => boolean): boolean { for (const x of xs) if (!f(x)) return false; return true; }
function mapTo<T, U>(xs: T[], f: (x: T) => U): U[] { const o: U[] = []; for (const x of xs) o.push(f(x)); return o; }
// 1. a `let` without initializer assigned on branches, then captured (settled)
function settledBranches(flag: boolean, xs: number[]): string {
  let memberName: string | undefined;
  if (flag) memberName = "m"; else if (xs.length > 2) memberName = "n";
  return every(xs, (x) => memberName === undefined || x > memberName.length) + ":" + memberName;
}
// 2. a parameter reassigned before the captures
function reassignedParam(type: number, xs: number[]): number[] {
  type = type * 2;
  type += 1;
  return mapTo(xs, (x) => x + type);
}
// 3. assigned AFTER a capture: the closure must see the later value (shared)
function assignedAfter(): number { let v = 1; const f = () => v; v = 2; return f() + v; }
// 4. assigned inside a closure: shared, both directions
function writtenByClosure(): string { let n = 0; const bump = () => { n += 3; }; bump(); bump(); const read = () => n; n = n * 10; return read() + "," + n; }
// 5. a loop re-assigning a binding declared outside it, captured in the same loop: shared (the last value wins)
function loopShared(xs: number[]): number[] { let cur = 0; const fs: (() => number)[] = []; for (const x of xs) { cur = x; fs.push(() => cur); } return mapTo(fs, (f) => f()); }
// 6. a per-iteration `let` assigned then captured inside the loop: by value, each iteration's own
function loopOwn(xs: number[]): number[] { const fs: (() => number)[] = []; for (const x of xs) { let m = 0; if (x & 1) m = x; else m = -x; fs.push(() => m); } return mapTo(fs, (f) => f()); }
// 7. assignment inside an inner loop, capture after it in the outer iteration (settled per outer iteration)
function nestedLoops(rows: number[][]): number[] { const fs: (() => number)[] = []; for (const row of rows) { let sum = 0; for (const c of row) sum += c; fs.push(() => sum); } return mapTo(fs, (f) => f()); }
// 8. for-of over an existing variable, captured in the body: shared (final value)
function forOfExisting(xs: string[]): string { let w = ""; const fs: (() => string)[] = []; for (w of xs) fs.push(() => w); return mapTo(fs, (f) => f()).join(","); }
// 9. destructuring and compound assignments before the capture (settled)
function destructured(a: number, b: number): number { [a, b] = [b, a]; a *= 10; return every([1], () => a > b) ? a + b : 0; }
// 10b. a closure created inside the assignment's own right-hand side sees the assigned value (shared)
function rhsCapture(): string { let cycle: { get: () => unknown } | undefined; cycle = { get: () => cycle }; return (cycle.get() === cycle) + ""; }
// 10. a nested declaration capturing an assigned binding: shared
function viaDeclaration(): number { let k = 1; function read(): number { return k; } k = 5; return read() + (every([0], () => read() === 5) ? 1 : 0); }
function main(): void {
  console.log(settledBranches(true, [1, 2]), settledBranches(false, [3, 4, 5]), settledBranches(false, [1]));
  console.log(reassignedParam(3, [1, 2]).join(","));
  console.log(assignedAfter(), writtenByClosure());
  console.log(loopShared([1, 2, 3]).join(","), loopOwn([1, 2, 3]).join(","), nestedLoops([[1, 2], [3]]).join(","));
  console.log(forOfExisting(["a", "b"]), destructured(1, 2), viaDeclaration(), rhsCapture());
  let acc = 0;
  for (let i = 0; i < 100000; i++) { let tag = i & 7; if (i & 1) tag += 100; const o = { v: i }; acc += every([o], (x) => x.v + tag >= i) ? 1 : 0; }
  console.log(acc);
}
main();
