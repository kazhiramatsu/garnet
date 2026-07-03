function main(): void {
  console.log(1 + "2");        // "12"
  console.log("3" + 4);        // "34"
  console.log(1 + 2 + "3");    // "33"
  console.log("1" + 2 + 3);    // "123"
  console.log(true + "x");     // "truex"
  console.log("" + null);      // "null"
  console.log("" + undefined); // "undefined"
  console.log("" + NaN);       // "NaN"
  console.log("" + Infinity);  // "Infinity"
  console.log([1, 2] + "");    // "1,2"
  console.log("" + [1, [2, 3]]); // "1,2,3"
  console.log("n" + (1 + 2) + true + null); // "n3truenull"
  console.log(1 + true);       // 2
  console.log("a" + 0.5 + "b");// "a0.5b"
  console.log("c" + (-0) + "d"); // "c0d"  (JSON/String of -0 is "0")
  console.log(`${true}-${null}-${undefined}-${[9, 8]}`); // "true-null-undefined-9,8"
}
main();
