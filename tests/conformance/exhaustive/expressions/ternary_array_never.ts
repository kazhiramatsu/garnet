// Two silent-miscompile fixes around conditional expressions and `never`:
//
// 1. A ternary whose branches are array literals (`cond ? [a] : [b]`) was lost:
//    the array-scalar SROA scalar-replaced a branch-local array that is Copy'd to
//    the ternary's result local and used after the enclosing `if`, dropping it to
//    undefined. The SROA now keeps such arrays materialized.
//
// 2. A value cast/typed as `never` (`value as never`, or a generic whose
//    conditional return type resolves to `never`) was classified unboxable and
//    coerced to NaN/null. `never` now stays boxed so the runtime value survives.
function main(): void {
  // ternary of array literals, returned / assigned / nested
  function pick(b: boolean): number[] { return b ? [1] : [2]; }
  console.log(JSON.stringify(pick(true)), JSON.stringify(pick(false))); // [1] [2]

  function pickEmpty(b: boolean): number[] { return b ? [1, 2] : []; }
  console.log(JSON.stringify(pickEmpty(true)), JSON.stringify(pickEmpty(false))); // [1,2] []

  function oneBranch(b: boolean): any { return b ? [1] : 0; }
  console.log(JSON.stringify(oneBranch(true)), oneBranch(false)); // [1] 0

  const x: number[] = (1 > 0) ? [10, 20] : [30];
  console.log(x.length, x[0], x[1]); // 2 10 20

  function nested(b: boolean): number[][] { return b ? [[1]] : [[2]]; }
  console.log(JSON.stringify(nested(true))); // [[1]]

  // copy + in-body use + return
  function copyUse(b: boolean): number[] {
    const a = b ? [1] : [2];
    console.log(a.length); // 1
    return a;
  }
  console.log(JSON.stringify(copyUse(true))); // [1]

  // an array allocated in an `if` branch, READ in-branch AND escaping after the
  // `if` (proper cross-branch escape analysis must keep it materialized — a
  // read-in-branch heuristic alone misses this).
  function branchEscape(b: boolean): number[] {
    let r: number[] = [];
    if (b) {
      r = [1, 2, 3];
      console.log(r.length); // 3
    }
    return r;
  }
  console.log(JSON.stringify(branchEscape(true)), JSON.stringify(branchEscape(false))); // [1,2,3] []

  // arrays confined to a branch still scalar-optimize (no over-disqualify)
  function confined(b: boolean): number {
    let s = 0;
    if (b) { const a = [1, 2]; s = a[0] + a[1]; }
    return s;
  }
  console.log(confined(true), confined(false)); // 3 0

  // plain array allocations still scalar-optimize correctly (no regression)
  function sum(): number { const a = [10, 20, 30]; return a[0] + a[1] + a[2]; }
  console.log(sum()); // 60

  // `never`: a deliberate cast carries a real runtime value
  function asNever(): never { return [1, 2] as never; }
  console.log(JSON.stringify((asNever as any)())); // [1,2]

  // generic with a conditional return type that resolves to `never`
  type D<T> = T extends string ? T[] : never;
  function dist<T>(v: T): D<T> {
    return (typeof v === "string" ? [v] : []) as D<T>;
  }
  console.log(JSON.stringify(dist("x")), JSON.stringify(dist(1))); // ["x"] []

  function neverNum<T>(v: T): T extends string ? number : never {
    return (typeof v === "string" ? 1 : undefined) as any;
  }
  console.log(neverNum(5)); // undefined
}
main();
