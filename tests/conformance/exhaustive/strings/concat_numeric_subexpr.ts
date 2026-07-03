// A parenthesized numeric '+' inside a string concatenation must stay a single
// numeric addition; the concatMany flattening optimization must not splice its
// operands into the string concat (which would turn `s + (i + 1)` into
// `s + i + 1` and concatenate the digits instead of adding them).
function main(): void {
  let i = 3;
  let j = 4;
  // 3+ operand chains (these trigger the concatMany fast path).
  console.log("p" + (i + j) + "q");        // (i+j) numeric -> "p7q"
  console.log("v=" + (i + 1) + "!");       // "v=4!"
  console.log("r" + (i * 2) + "s");        // "r6s"
  console.log("n=" + (i + 1) + ",m=" + (j + 2)); // "n=4,m=6"
  console.log("a" + i + j + "b");          // no parens: "a34b"
  console.log(i + j + "x");                // leading numeric add then string: "7x"

  // The original miscompile: building JSON-ish text in a loop with (i+1).
  let out = "";
  for (let k = 0; k < 5; k++) {
    out += '{"v":' + (k + 1) + "}";
  }
  console.log(out);
}

main();
