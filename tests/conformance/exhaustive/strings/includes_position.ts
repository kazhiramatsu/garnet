// String.includes honors its position argument.
function main(): void {
  console.log("hello".includes("lo", 10));        // false (start past end)
  console.log("hello".includes("lo", 3), "hello".includes("he", 1)); // true false
  console.log("hello".includes("ell"), "hello".includes("xyz"));     // true false
  console.log("hello".includes("", 2), "hello".includes(""));        // true true
}

main();
