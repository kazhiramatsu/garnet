// garnet:arena in an ordinary process (docs/arena_design.md): what the work allocates is kept without
// being traced, and is old when it returns. Nothing a program can see differs from calling the work
// (Node's polyfill does just that): the values built inside are intact after the collections that
// follow, a cell of the arena that refers to a cell made before it keeps it, arenas nest, a throw ends
// one, and what was made inside can be written afterwards (nothing is frozen outside a shared worker).
import { arena } from "garnet:arena";

class N {
  constructor(public k: number, public next: N | undefined, public name: string, public list: number[]) {}
}
function build(n: number): N | undefined {
  let head: N | undefined = undefined;
  for (let i = 0; i < n; i++) head = new N(i, head, "n" + i, [i, i + 1]);
  return head;
}
function sum(h: N | undefined): number {
  let s = 0;
  for (let p = h; p !== undefined; p = p.next) s += p.k + p.list[1]! + p.name.length;
  return s;
}
// young garbage, enough for several collections
function churn(): number {
  let t = 0;
  for (let i = 0; i < 300000; i++) {
    const o = { a: i, b: [i, "s" + (i & 7)] };
    t += (o.b[0] as number) & 1;
  }
  return t;
}

function main(): void {
  const before = build(1000);   // young when the first arena begins
  const a = arena(() => build(50000));
  console.log(sum(a), sum(before));
  console.log(churn());
  const b = arena(() => {
    const outer = build(20000);
    const inner = arena(() => build(10));
    return sum(inner) > 0 ? outer : inner;
  });
  console.log(sum(a), sum(b), sum(before), churn());

  // a cell of the arena that refers to a cell made before it, and maps, sets, closures, a big array
  const kept = { v: [1, 2, 3] };
  let made = { w: "young" + String(sum(before) % 7) };
  const c = arena(() => {
    const big: number[] = [];
    for (let i = 0; i < 200000; i++) big.push(i * 2);
    const text = "x".repeat(5000) + String(big.length);
    return { kept, made, m: new Map([[1, kept]]), s: new Set(["x", text]), f: (n: number) => n + big[n]!, big, text };
  });
  made = { w: "later" };
  churn();
  console.log(c.kept.v.join(), c.made.w, c.m.get(1)!.v.length, c.s.has("x"), c.s.size, c.f(1000), c.big.length, c.text.length);

  // written after the arena, with young values
  a!.k = 7;
  a!.next!.name = "renamed" + String(churn() % 3);
  c.kept.v.push(4);
  c.m.set(2, { v: [9] });
  c.big.push(1);
  churn();
  console.log(a!.k, a!.next!.name, c.kept.v.length, c.m.get(2)!.v[0], c.big.length, Object.isFrozen(c), Object.isFrozen(a));

  // a throw inside ends the arena
  try {
    arena(() => {
      build(100);
      throw new Error("out");
    });
  } catch (e) {
    console.log((e as Error).message);
  }
  console.log(sum(arena(() => build(3))), churn());

  // many small arenas between collections
  let total = 0;
  const lists: (N | undefined)[] = [];
  for (let i = 0; i < 300; i++) {
    lists.push(arena(() => build(50 + (i % 13))));
    if (i % 50 === 49) total += churn();
  }
  for (const l of lists) total += sum(l);
  console.log(total);
}
main();
