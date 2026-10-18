// switch lowering: direct chain (no fall-through) and the generic form (fall-through),
// grouped labels, a default in the middle, lazy case-expression evaluation, breaks,
// continue inside a loop, string and mixed discriminants, duplicate labels.
let evals = 0;
function k(n: number): number { evals++; return n; }
function dispatch(x: number): string {
  switch (x) {
    case k(1): return "one";
    case k(2): case k(3): return "two-three";
    default: return "other";
    case k(4): return "four";
  }
}
function grouped(x: number): number {
  let r = 0;
  switch (x) {
    case 0: r = 10; break;
    case 1: case 2: { r = 20; break; }
    case 3: r = 30; break;
    default: r = -1;
  }
  return r;
}
function fallthrough(x: number): string {
  let s = "";
  switch (x) {
    case 1: s += "a";
    case 2: s += "b"; break;
    case 3: s += "c";
    default: s += "d";
  }
  return s;
}
function strings(s: string): number {
  switch (s) { case "alpha": return 1; case "beta": case "gamma": return 2; default: return 0; }
}
function mixed(v: any): string {
  switch (v) { case 1: return "num"; case "1": return "str"; case true: return "bool"; case undefined: return "undef"; case null: return "null"; default: return "?"; }
}
function loopy(): number {
  let acc = 0;
  for (let i = 0; i < 6; i++) {
    switch (i % 3) {
      case 0: continue;
      case 1: acc += 10; break;
      default: acc += 1;
    }
    acc += 100;
  }
  return acc;
}
function dup(x: number): string {
  switch (x) { case 1: return "first"; case 1: return "second"; default: return "none"; }
}
function emptyLast(x: number): number {
  let r = 1;
  switch (x) { case 1: r = 2; break; case 2: }
  return r;
}
// jump-table edge cases: negative and large labels, non-integral / NaN / boxed
// discriminants, a chain inside a loop, an empty default, a hand-written chain.
function wide(x: number): number {
  switch (x) { case -5: return 1; case 0: return 2; case 7: return 3; case 2147483647: return 4; case 3000000000: return 5; default: return 0; }
}
function chainFn(x: number): number {
  if (x === 10) return 1; else if (x === 20) return 2; else if (x === 30) return 3; else if (x === 40) return 4; else if (x === 50) return 5;
  return -1;
}
function boxed(v: any): number {
  switch (v) { case 1: return 1; case 2: return 2; case 3: return 3; case 4: return 4; default: return 9; }
}
function inLoop(limit: number): number {
  let acc = 0;
  for (let i = 0; i < limit; i++) {
    switch (i & 7) { case 0: continue; case 1: acc += 1; break; case 2: case 3: acc += 10; break; case 4: break; case 5: acc += 100; break; default: acc += 1000; }
    acc += 1;
  }
  return acc;
}
function main(): void {
  console.log(dispatch(1), dispatch(3), dispatch(4), dispatch(9), evals);
  console.log(grouped(0), grouped(2), grouped(3), grouped(7));
  console.log(fallthrough(1), fallthrough(2), fallthrough(3), fallthrough(4));
  console.log(strings("alpha"), strings("gamma"), strings("delta"));
  console.log(mixed(1), mixed("1"), mixed(true), mixed(undefined), mixed(null), mixed(2));
  console.log(loopy(), dup(1), dup(2), emptyLast(1), emptyLast(2), emptyLast(3));
  console.log(wide(-5), wide(0), wide(7), wide(2147483647), wide(3000000000), wide(1.5), wide(NaN), wide(-0), wide(8));
  console.log(chainFn(10), chainFn(50), chainFn(55), chainFn(NaN), boxed(1), boxed("1"), boxed(4), boxed(true), boxed(2.0), boxed(null));
  console.log(inLoop(40));
}
main();
