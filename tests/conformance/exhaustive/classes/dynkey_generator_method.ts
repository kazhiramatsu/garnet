// Generator methods keyed by a USER symbol (`*[mySym]()`) or a DYNAMIC string
// (`*[k]()`), both instance and static. (Well-known `*[Symbol.iterator]()` takes
// the vtable path and is covered elsewhere.) The coroutine state machine is boxed
// as a ts_func value and installed under the symbol/dynamic key, then driven by
// for-of / spread / manual .next() exactly like a vtable generator method. A
// user `unique symbol` key gives the access a real type so for-of/.next resolve;
// the dynamic-string key is read through a spread (the natural drive form).

const gi: unique symbol = Symbol("gi");
const gs: unique symbol = Symbol("gs");
const gb: unique symbol = Symbol("gb");
const dynKey = "d" + "yn";

class Seq {
  base = 100;
  // instance generator, user-symbol key, captures `this`.
  *[gi](): Generator<number> {
    yield this.base;
    yield this.base + 1;
    yield this.base + 2;
  }
  // instance generator with a bidirectional yield (sent value flows back in).
  *[gb](): Generator<number, void, number> {
    const a = yield 1;
    yield a + 10;
  }
  // static generator, user-symbol key, reads a static field via `this` (= class).
  static start = 7;
  static *[gs](): Generator<number> {
    yield Seq.start;
    yield Seq.start * 2;
  }
  // instance generator, dynamic STRING key.
  *[dynKey](n: number): Generator<number> {
    yield n;
    yield n + 10;
  }
}

function main(): void {
  const s = new Seq();

  // instance user-symbol generator via for-of (captures this.base)
  let sum = 0;
  for (const x of s[gi]()) sum += x;
  console.log(sum); // 303

  // spread drive
  console.log([...s[gi]()].join(",")); // 100,101,102

  // static user-symbol generator via for-of
  let st = 0;
  for (const x of Seq[gs]()) st += x;
  console.log(st); // 21

  // dynamic-string-keyed instance generator via spread (any-typed access)
  console.log([...(s as any)[dynKey](5)].join(",")); // 5,15

  // manual .next() over the user-symbol generator
  const g = s[gi]();
  console.log(g.next().value, g.next().value, g.next().value, g.next().done); // 100 101 102 false

  // bidirectional .next(v): the value sent in becomes the result of `yield`
  const b = s[gb]();
  console.log(b.next().value, b.next(5).value); // 1 15

  // fresh generator each call (independent state)
  let u = 0;
  for (const x of s[gi]()) u += x;
  for (const x of s[gi]()) u += x;
  console.log(u); // 606
}

main();
