// Spreading / Array.from over a USER-DEFINED iterable must drive the iterator
// protocol: call [Symbol.iterator]() to get the iterator, then .next() until done.
// (for-of already did this; spread and Array.from previously gave an empty array.)
class Range {
  constructor(private lo: number, private hi: number) {}
  [Symbol.iterator]() {
    let i = this.lo; const hi = this.hi;
    return { next: () => i < hi ? { value: i++, done: false } : { value: undefined, done: true } };
  }
}

class GenRange {
  constructor(private n: number) {}
  *[Symbol.iterator]() { for (let i = 0; i < this.n; i++) yield i * 10; }
}

function* g() { yield 1; yield 2; yield 3; }

function main(): void {
  const objIter = {
    [Symbol.iterator]() {
      let i = 0;
      return { next: () => i < 3 ? { value: i++, done: false } : { value: 0, done: true } };
    },
  };

  // spread of a user iterable (object literal, class, generator-method class)
  console.log([...objIter].join(","));          // 0,1,2
  console.log([...new Range(2, 5)].join(","));   // 2,3,4
  console.log([...new GenRange(3)].join(","));   // 0,10,20

  // Array.from of the same
  console.log(Array.from(objIter).join(","));            // 0,1,2
  console.log(Array.from(new Range(1, 4)).join(","));     // 1,2,3
  console.log(Array.from(new GenRange(2)).join(","));     // 0,10
  console.log(Array.from(new Range(0, 3), x => x * 2).join(",")); // 0,2,4

  // for-of (regression)
  let s = "";
  for (const x of new Range(5, 8)) s += x;
  console.log(s);                                // 567

  // builtin iterables still work
  console.log([...g()].join(","), Array.from(g()).join(",")); // 1,2,3 1,2,3
  console.log([...new Set([3, 1, 2])].join(","));             // 3,1,2
  console.log(Array.from(new Set([1, 1, 2])).join(","));      // 1,2
  console.log(Array.from("abc").join(","));                   // a,b,c

  // Array.from over an array-LIKE (length + numeric keys, NOT iterable)
  console.log(Array.from({ length: 3, 0: "a", 1: "b", 2: "c" } as any).join(",")); // a,b,c
  console.log(Array.from({ length: 2 } as any).join("|"));    // |  (two undefined)

  // String.split with no / undefined separator -> whole string (not chars)
  console.log(JSON.stringify("abc".split()));                 // ["abc"]
  console.log(JSON.stringify("abc".split(undefined)));        // ["abc"]
  console.log(JSON.stringify("abc".split("")));               // ["a","b","c"]
  console.log(JSON.stringify("a,b,c".split(",")));            // ["a","b","c"]
  console.log(JSON.stringify("abc".split(undefined, 0)));     // []
}

main();
