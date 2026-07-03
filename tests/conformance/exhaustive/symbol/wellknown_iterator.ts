function main(): void {
  // Symbol.iterator as a value: singleton, typeof, identity.
  const k = Symbol.iterator;
  console.log(typeof k);                       // symbol
  console.log(Symbol.iterator === Symbol.iterator); // true

  // obj[Symbol.iterator] read/write (well-known symbol key).
  const o: any = {};
  o[Symbol.iterator] = 42;
  console.log(o[Symbol.iterator]);             // 42

  // object literal with a [Symbol.iterator]() method, driven by for-of.
  let i = 0;
  const iterable = {
    [Symbol.iterator]() {
      return { next() { return i < 3 ? { value: i++, done: false } : { value: 0, done: true }; } };
    }
  };
  for (const x of iterable) { console.log(x); } // 0 1 2

  // method-local state variant.
  const iterable2 = {
    [Symbol.iterator]() {
      let n = 10;
      return { next() { return n < 13 ? { value: n++, done: false } : { value: 0, done: true }; } };
    }
  };
  for (const x of iterable2) { console.log(x); } // 10 11 12
}
main();
