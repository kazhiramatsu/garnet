// A well-known-symbol STATIC method (`static [Symbol.iterator]()`) is registered
// on the class's static container under the symbol key, so reading it via
// `C[Symbol.iterator]`, spreading `[...C]`, and `for...of C` (making the class
// itself iterable) all work — and `this` inside the method is the class. It must
// NOT be confused with an INSTANCE `[Symbol.iterator]()` of the same class, and it
// is inherited by subclasses via the proto-linked container chain.
class Span {
  static [Symbol.iterator](): Iterator<number> {
    let i = 2;
    const end = 5;
    return {
      next: () => i < end
        ? { value: i++, done: false }
        : { value: undefined as any, done: true },
    };
  }
}

class Gen {
  static label = 10;
  static *[Symbol.iterator](): Generator<number> {
    yield this.label;        // `this` is the class (container)
    yield this.label * 2;
  }
}

class SubGen extends Gen {}   // inherits the static [Symbol.iterator]

// A class with BOTH a static and an instance [Symbol.iterator]: they must resolve
// independently (static on the class, instance on the prototype).
class Dual {
  a = 9;
  b = 8;
  static *[Symbol.iterator](): Generator<number> { yield 1; yield 2; }
  *[Symbol.iterator](): Generator<number> { yield this.a; yield this.b; }
}

function main(): void {
  // read the static symbol method as a value
  console.log(typeof Span[Symbol.iterator]); // function

  // the class is iterable via its static [Symbol.iterator]
  console.log([...Span].join(","));          // 2,3,4
  let sum = 0;
  for (const x of Span) sum += x;
  console.log(sum);                           // 9

  // generator static iterator, with `this` = the class
  console.log([...Gen].join(","));            // 10,20

  // inherited static iterator
  console.log([...SubGen].join(","));         // 10,20

  // static vs instance [Symbol.iterator] are independent
  console.log([...Dual].join(","));           // 1,2   (static, on the class)
  console.log([...new Dual()].join(","));     // 9,8   (instance, on the prototype)
}

main();
