// Array.reduceRight (with and without an initial value) and Array.copyWithin.
function main(): void {
  // reduceRight folds from the end; no init -> seed with the last element.
  console.log([1, 2, 3, 4].reduceRight((a: number, b: number) => a + b));      // 10
  console.log([1, 2, 3, 4].reduceRight((a: number, b: number) => a - b));      // -2
  console.log(["a", "b", "c"].reduceRight((acc: string, x: string) => acc + x, "")); // cba

  // visit order is right-to-left.
  const idx: number[] = [];
  [10, 20, 30].reduceRight((a: number, _b: number, i: number) => { idx.push(i); return a; }, 0);
  console.log(idx.join(","));                                                  // 2,1,0

  // copyWithin(target, start, end?) copies a slice in place; length unchanged.
  console.log([1, 2, 3, 4, 5].copyWithin(0, 3).join(","));                     // 4,5,3,4,5
  console.log([1, 2, 3, 4, 5].copyWithin(0, 3, 4).join(","));                  // 4,2,3,4,5
  console.log([1, 2, 3, 4, 5].copyWithin(-2).join(","));                       // 1,2,3,1,2
  console.log([1, 2, 3, 4, 5].copyWithin(1, 3).join(","));                     // 1,4,5,4,5

  // Math.max/min with 0, 1, and N args (incl. NaN propagation).
  console.log(Math.max(), Math.min());                                        // -Infinity Infinity
  console.log(Math.max(-5), Math.min(-5));                                    // -5 -5
  console.log(Math.max(1, 5, 3, 9, 2), Math.min(4, 1, 8));                     // 9 1
  console.log(Math.max(1, NaN, 3));                                           // NaN
}

main();
