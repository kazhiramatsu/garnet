// ES2023 change-array-by-copy methods: toSorted / toReversed / with / toSpliced.
// Each returns a NEW array and leaves the receiver unchanged (the key contrast with
// the in-place sort/reverse/splice). V8 is the oracle.

function main(): void {
  // toSorted: default (string order) and with a comparator; receiver unchanged.
  const a = [3, 1, 2, 10, 20];
  console.log(JSON.stringify(a.toSorted()));            // [1,10,2,20,3] (string order)
  console.log(JSON.stringify(a.toSorted((x, y) => x - y))); // [1,2,3,10,20]
  console.log(JSON.stringify(a.toSorted((x, y) => y - x))); // [20,10,3,2,1]
  console.log(JSON.stringify(a));                       // unchanged [3,1,2,10,20]

  const words = ["banana", "apple", "cherry"];
  console.log(JSON.stringify(words.toSorted()));        // sorted copy
  console.log(JSON.stringify(words));                   // unchanged

  // toReversed: reversed copy; receiver unchanged.
  const b = [1, 2, 3, 4];
  console.log(JSON.stringify(b.toReversed()));          // [4,3,2,1]
  console.log(JSON.stringify(b));                       // unchanged

  // with: replace one element by index (negative counts from the end); copy.
  const c = [1, 2, 3];
  console.log(JSON.stringify(c.with(0, 9)));            // [9,2,3]
  console.log(JSON.stringify(c.with(1, 9)));            // [1,9,3]
  console.log(JSON.stringify(c.with(-1, 9)));           // [1,2,9]
  console.log(JSON.stringify(c));                       // unchanged

  // toSpliced: change-by-copy splice. 1-arg deletes to end; deleteCount; insertion;
  // negative start. Receiver unchanged throughout.
  const d = [1, 2, 3, 4, 5];
  console.log(JSON.stringify(d.toSpliced(1)));          // [1]
  console.log(JSON.stringify(d.toSpliced(1, 2)));       // [1,4,5]
  console.log(JSON.stringify(d.toSpliced(1, 2, 9, 8))); // [1,9,8,4,5]
  console.log(JSON.stringify(d.toSpliced(-2, 1)));      // [1,2,3,5]
  console.log(JSON.stringify(d.toSpliced(0, 0, 0)));    // [0,1,2,3,4,5] (pure insert)
  console.log(JSON.stringify(d));                       // unchanged [1,2,3,4,5]

  // chaining / composition with existing methods
  console.log(JSON.stringify([5, 3, 4, 1, 2].toSorted((x, y) => x - y).toReversed()));
  console.log([3, 1, 2].toSorted().map((x) => x * 10).join(","));
}

main();
