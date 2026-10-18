// Nested function declarations are direct-call targets: a call `g(x)` binds
// to the declaration and threads the enclosing scope records, and a
// declaration that is never used as a value is not hoisted into a closure at
// all. Value uses (callbacks, shorthand properties, `.call`, `typeof`,
// returned functions) still see one closure per activation with the right
// identity. Covers sibling calls, recursion, deeper nesting, declarations in
// loops and blocks, methods, generators and async functions.

function outer(x: number): string {
  function g(v: number): number { return x + v; }
  function direct(v: number): number { return g(v) * 2; }
  function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }
  const h = () => [1, 2].map(g);
  const k = () => direct(5);
  const viaCall = () => g.call(null, 7);
  const same = () => g === g;
  const api = { g, direct };
  let depth = "";
  function level1(a: number): number {
    function level2(b: number): number {
      function level3(c: number): number { depth += "3"; return a + b + c + x; }
      depth += "2";
      return level3(b) + level3(1);
    }
    depth += "1";
    return level2(a) + level2(2);
  }
  return [h().join(","), k(), viaCall(), typeof g, same(), api.g(1), api.direct(1), fact(5), level1(10), depth, direct(1)].join("|");
}

function loopsAndBlocks(): string {
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    function inLoop(): string { return "i" + i; }
    out.push(inLoop());
    if (i === 1) {
      function inBlock(): string { return "b" + i; }
      out.push(inBlock());
    }
  }
  return out.join(",");
}

class Holder {
  constructor(private base: number) {}
  compute(n: number): number {
    const self = this;
    function helper(v: number): number { return self.base + v; }
    function twice(v: number): number { return helper(v) * 2; }
    return twice(n) + helper(1);
  }
}

function* genOuter(limit: number): Generator<number, string, unknown> {
  function step(i: number): number { return i * 3; }
  for (let i = 0; i < limit; i++) yield step(i);
  return "done" + step(limit);
}

async function asyncOuter(v: number): Promise<number> {
  async function inner(w: number): Promise<number> { await Promise.resolve(); return w + v; }
  function sync(w: number): number { return w * 2; }
  return sync(await inner(1)) + (await inner(2));
}

function onlyCalled(): number {
  let acc = 0;
  function add(n: number): void { acc += n; }
  function run(): void { for (let i = 0; i < 5; i++) add(i); }
  run(); run();
  return acc;
}

function main(): void {
  console.log(outer(10));
  console.log(outer(1));
  console.log(loopsAndBlocks());
  console.log(new Holder(5).compute(3));
  const it = genOuter(3);
  const seen: unknown[] = []; let r = it.next(); while (!r.done) { seen.push(r.value); r = it.next(); } seen.push(r.value);
  console.log(seen.join(","));
  console.log(onlyCalled());
  asyncOuter(100).then((n) => console.log("async", n));
}
main();
