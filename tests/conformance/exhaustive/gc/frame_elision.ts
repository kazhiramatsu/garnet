// Frame elision (docs/frame_elision_design.md): a reference local gets a
// frame slot only when it is live across a collection point, or read at one
// that does not keep it. Every case below allocates between the uses that
// matter, so a missing slot shows up under TSAOT_GC_YOUNG_THRESHOLD=1.

interface Node {
  v: number;
  next: Node | null;
}

function mk(v: number, next: Node | null): Node {
  return { v, next };
}

function sum(n: Node | null): number {
  let s = 0;
  while (n !== null) {
    s += n.v;
    n = n.next;
  }
  return s;
}

// 1. a parameter only handed to a direct call
function isBig(n: Node): boolean {
  return sum(n) > 10;
}

// 2. handed to a direct call, then read again after more allocation
function reuse(n: Node): number {
  const before = sum(n);
  const extra = mk(100, null);
  return before + sum(n) + extra.v;
}

// 3. last use is a runtime call that allocates
function pushAll(xs: Node[], n: Node): number {
  const fresh = mk(n.v * 2, n);
  xs.push(fresh);
  xs.push(mk(1, null));
  return xs.length;
}

// 4. loop-carried reference with allocation in every iteration
function chain(k: number): number {
  let prev: Node | null = null;
  for (let i = 0; i < k; i++) {
    const cur = mk(i, prev);
    const junk = [i, i + 1, i + 2];
    prev = cur;
    if (junk.length !== 3) return -1;
  }
  return sum(prev);
}

// 5. a reference read in a catch after a throwing call
function thrower(n: Node): number {
  if (n.v > 2) throw new Error("big " + n.v);
  return n.v;
}
function catcher(k: number): string {
  const keep = mk(k, null);
  try {
    const a = mk(k + 1, keep);
    return "ok " + thrower(a);
  } catch (e) {
    const filler = [mk(1, null), mk(2, null)];
    return (e as Error).message + " " + keep.v + " " + filler.length;
  }
}

// 6. defined late in a loop body, read early in the next iteration
function lateDef(k: number): number {
  let total = 0;
  let last: Node | null = null;
  for (let i = 0; i < k; i++) {
    if (last !== null) {
      const tmp = mk(0, null);
      total += last.v + tmp.v;
    }
    last = mk(i * 3, null);
  }
  return total;
}

// 7. `this` handed to a method that allocates before reading it
class Box {
  items: Node[] = [];
  constructor(public tag: string) {}
  add(v: number): Box {
    const n = mk(v, null);
    this.items.push(n);
    return this;
  }
  total(): number {
    let t = 0;
    for (const n of this.items) t += n.v;
    return t;
  }
}
function boxes(k: number): string {
  const b = new Box("b" + k);
  for (let i = 0; i < k; i++) b.add(i);
  return b.tag + ":" + b.total();
}

// 8. a getter runs user code (and allocates) between uses
class Lazy {
  private n: Node | null = null;
  get node(): Node {
    const n = mk(7, mk(8, null));
    this.n = n;
    return n;
  }
}
function viaGetter(): number {
  const keep = mk(5, null);
  const l = new Lazy();
  const g = l.node;
  return keep.v + sum(g);
}

// 9. captured cells passed to a direct call of a closure
function closures(k: number): number {
  let acc: Node | null = null;
  function addOne(i: number): void {
    acc = mk(i, acc);
  }
  for (let i = 0; i < k; i++) addOne(i);
  return sum(acc);
}

// 10. a direct call with more arguments than parameters
function two(a: Node, b: Node): number {
  const t = mk(0, null);
  return a.v + b.v + t.v;
}
function extraArgs(): number {
  const f = two as (a: Node, b: Node, c: Node) => number;
  return f(mk(1, null), mk(2, null), mk(3, null));
}

// 11. callees that keep their arguments differently: rest parameters and
// `arguments` (no direct entry), whose callers keep the slots
function rest(...xs: Node[]): number {
  const pad = mk(0, null);
  let s = pad.v;
  for (const x of xs) s += x.v;
  return s;
}
function viaArguments(a: Node, b: Node): number {
  const pad = mk(0, null);
  return arguments.length + a.v + b.v + pad.v;
}

// 12. a string accumulator returned from the function
function joinAll(k: number): string {
  let s = "";
  for (let i = 0; i < k; i++) s += "<" + i + ">";
  return s;
}

// 13. a reference passed to a direct call and to the runtime in one call's
// arguments, evaluated left to right with allocation in between
function args3(a: Node, b: string, c: Node): string {
  return a.v + b + c.v;
}
function mixedArgs(k: number): string {
  const x = mk(k, null);
  return args3(x, "-" + k + "-", mk(k + 1, x));
}

function main(): void {
  const results: string[] = [];
  for (let round = 0; round < 3; round++) {
    results.push("1 " + isBig(mk(5, mk(6, null))));
    results.push("2 " + reuse(mk(3, mk(4, null))));
    const xs: Node[] = [];
    results.push("3 " + pushAll(xs, mk(9, null)) + " " + sum(xs[0]));
    results.push("4 " + chain(50));
    results.push("5 " + catcher(1) + " | " + catcher(5));
    results.push("6 " + lateDef(20));
    results.push("7 " + boxes(10));
    results.push("8 " + viaGetter());
    results.push("9 " + closures(30));
    results.push("10 " + extraArgs());
    results.push("11 " + rest(mk(1, null), mk(2, null), mk(3, null)) + " " + viaArguments(mk(4, null), mk(5, null)));
    results.push("12 " + joinAll(12));
    results.push("13 " + mixedArgs(round));
  }
  for (const r of results) console.log(r);
}
main();
