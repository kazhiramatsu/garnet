// String concat interleaved with arithmetic/relational/ternary subexpressions:
// the concat flattening must preserve each subexpression's own evaluation.
function main(): void {
  let i = 5, j = 2;
  console.log("a" + (i - j) + "b" + (i * j) + "c");      // a3b10c
  console.log("d" + (i / j) + "e");                       // d2.5e
  console.log("f" + (i % j) + "g");                       // f1g
  console.log("h" + (i > j ? "Y" : "N") + "k");           // hYk
  console.log("p" + (i ** j) + "q");                      // p25q
  console.log("" + i + j + (i + j));                      // 527
  console.log("x" + -i + "y");                            // x-5y
  console.log("z" + (i & j) + "|" + (i | j));             // z0|7
  const s = "v"; console.log(s + (i + 1) + s + (j + 1));  // v6v3
  let acc = "";
  for (let k = 0; k < 4; k++) acc += "[" + (k * k) + "]";
  console.log(acc);                                        // [0][1][4][9]
}
main();
