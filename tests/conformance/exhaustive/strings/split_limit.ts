// String.split with an optional limit truncates the result to `limit` substrings.
function main(): void {
  console.log("a,b,c,d".split(",", 2).join("|"));  // a|b
  console.log("a,b,c".split(",", 0).length);       // 0
  console.log("a,b".split(",", 10).join("|"));      // a|b
  console.log("a,b,c".split(",").join("|"));        // a|b|c
  console.log("abcd".split("", 2).join("|"));       // a|b
  const s: string = "x-y-z";
  console.log(s.split("-", 2).join("|"));           // x|y
  // a negative limit is ToUint32'd to a huge value -> effectively no limit.
  console.log("a,b,c".split(",", -1).join("|"));    // a|b|c
}

main();
