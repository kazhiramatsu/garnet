// A class generator method (`*gen()`) must return a generator that yields its body,
// not be optimized away. The SROA inliner used to splice a generator method's body
// into the caller whenever the receiver was scalar-replaceable, so `new C().gen()`
// yielded NOTHING. Fix: never inline generator/async methods, and keep their receiver
// materialized (their `this` is captured into a coroutine frame). Covers instance /
// this-field / params / inherited / nested / static generators + async methods.
class Counter {
  start: number;
  constructor(start: number) { this.start = start; }
  *upTo(n: number) { for (let i = this.start; i < this.start + n; i++) yield i; }
}
class Box {
  v = 5;
  *gen() { yield this.v; yield this.v * 2; }
  plain() { return this.v + 1; }
  *withPlain() { yield this.v; yield this.plain(); }
}
class A { *seq() { yield 1; yield 2; } }
class B extends A {}
class Wrap { *inner() { yield 7; yield 8; } run() { return this.inner(); } }
class Stat { static *gen() { yield 100; yield 200; } }
class Early { *gen() { yield 1; return; yield 2; } }
class Async { v = 21; async dbl() { return this.v * 2; } async lit() { return 9; } }

async function main(): Promise<void> {
  console.log([...new Box().gen()].join(","));              // 5,10
  console.log(new Box().plain());                           // 6
  console.log([...new Box().withPlain()].join(","));        // 5,6
  console.log([...new Counter(3).upTo(4)].join(","));       // 3,4,5,6
  const c = new Counter(10);
  console.log([...c.upTo(2)].join(","));                    // 10,11
  console.log([...new B().seq()].join(","));                // 1,2  (inherited)
  console.log([...new Wrap().run()].join(","));             // 7,8  (nested this.gen())
  console.log([...Stat.gen()].join(","));                   // 100,200  (static)
  console.log([...new Early().gen()].join(","));            // 1  (early return)
  // index-driven iteration of a generator method
  const it = new Box().gen();
  console.log(it.next().value, it.next().value, it.next().done); // 5 10 true
  // for-of over a generator method (simple loop variable)
  let s = 0; for (const x of new Counter(1).upTo(3)) s += x; console.log(s); // 6
  // distinct instances keep independent state
  console.log([...new Counter(0).upTo(1)][0], [...new Counter(100).upTo(1)][0]); // 0 100
  // async methods now return real Promises (await and .then both work)
  console.log(await new Async().dbl());                     // 42
  console.log(await new Async().lit());                     // 9
  await new Async().dbl().then((x) => console.log(x));      // 42
}
main();
