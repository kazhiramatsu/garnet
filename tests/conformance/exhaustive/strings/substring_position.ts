// substring swaps its arguments when start > end (and clamps negatives to 0),
// unlike slice. startsWith/endsWith honor their position arguments. join renders
// undefined/null as empty and defaults the separator to ",". Array.toString = join(",").
function main(): void {
  console.log("hello".substring(3, 1));        // el
  console.log("hello".substring(1, 3), "hello".substring(2)); // el llo
  console.log("hello".substring(-5, 3));        // hel
  console.log("hello".slice(1, -1), "hello".slice(-3)); // ell llo

  console.log("hello".startsWith("llo", 2), "hello".startsWith("he")); // true true
  console.log("hello".endsWith("ell", 4), "hello".endsWith("lo"));     // true true

  console.log([1, undefined, 3, null].join(",")); // 1,,3,
  console.log([1, 2, 3].join(), [1, 2, 3].join(undefined)); // 1,2,3 1,2,3
  console.log([1, 2, 3].join("-"));             // 1-2-3

  console.log([1, 2, 3].toString());            // 1,2,3
  console.log(String([1, [2, 3]]));             // 1,2,3
}

main();
