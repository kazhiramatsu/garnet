function main(): void {
  console.log(1 == "1", 1 === "1");      // true false
  console.log(null == undefined, null === undefined); // true false
  console.log(0 == false, 0 === false);  // true false
  console.log("" == false);              // true
  console.log(NaN == NaN, NaN === NaN);  // false false
  console.log(2 < 10, "2" < "10");       // true false (string compare)
  console.log("apple" < "banana");       // true
  console.log(1 <= 1, 1 >= 2);           // true false
  console.log(null == 0, null < 1, null <= 0); // false true true
  console.log(undefined == 0);           // false
  let a: any = {}; let b: any = {};
  console.log(a == a, a == b);           // true false
}
main();
