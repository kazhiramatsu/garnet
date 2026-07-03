// `for...of` (and spread) over an object/class whose `[Symbol.iterator]` is a
// GENERATOR method. Calling such a `[Symbol.iterator]()` returns a generator
// object (driven by the generator.next builtin, no `.next` property), so the
// iterator-stepping must fall back to it — while still handling plain iterator
// objects and class iterators whose `next` is a prototype method.

// object literal with a generator [Symbol.iterator]
const objIterable = {
  *[Symbol.iterator](): Generator<number> {
    yield 1;
    yield 2;
    yield 3;
  },
};

// a generator [Symbol.iterator] passed through a variable (type still inferred)
function makeIterable(): { [Symbol.iterator](): Generator<number> } {
  return {
    *[Symbol.iterator](): Generator<number> {
      yield 10;
      yield 20;
    },
  };
}

// a class iterator (iterable AND iterator): `[Symbol.iterator]` returns `this`, and
// `next()` is a prototype METHOD — must NOT be mis-stepped as a generator.
class Counter {
  private i = 0;
  constructor(private max: number) {}
  [Symbol.iterator](): Counter { return this; }
  next(): { value: number; done: boolean } {
    if (this.i < this.max) { const v = this.i; this.i += 1; return { value: v, done: false }; }
    return { value: 0, done: true };
  }
}

function main(): void {
  // for...of over an object-literal generator iterable
  let s = 0;
  for (const x of objIterable) s += x;
  console.log(s);                              // 6

  // spread over the same
  console.log([...objIterable].join(","));     // 1,2,3

  // through a variable
  let t = 0;
  for (const x of makeIterable()) t += x;
  console.log(t);                              // 30

  // early break still terminates
  let first = -1;
  for (const x of objIterable) { first = x; break; }
  console.log(first);                          // 1

  // class iterator (prototype `next` method) — for...of and yield* both work
  let c = 0;
  for (const x of new Counter(4)) c += x;
  console.log(c);                              // 0+1+2+3 = 6

  function* wrap(): Generator<number> {
    yield 100;
    yield* new Counter(3);                     // yield* over a class iterator
    yield 200;
  }
  console.log([...wrap()].join(","));          // 100,0,1,2,200
}

main();
