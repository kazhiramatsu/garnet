// Template literals are a second concatenation path; numeric/expr substitutions
// must each evaluate independently (parallel to the string '+' flattening fix).
function main(): void {
  let i = 5, j = 2;
  console.log(`a${i - j}b${i * j}c`);          // a3b10c
  console.log(`v=${i + 1},w=${j + 1}`);        // v=6,w=3
  console.log(`${i}${j}${i + j}`);             // 527
  console.log(`sum=${i + j} prod=${i * j}`);   // sum=7 prod=10
  console.log(`neg=${-i} not=${!i}`);          // neg=-5 not=false
  console.log(`tern=${i > j ? "Y" : "N"}`);    // tern=Y
  console.log(`nested ${`inner${i}`} end`);    // nested inner5 end
  const a = [1, 2, 3];
  console.log(`arr=${a} len=${a.length}`);     // arr=1,2,3 len=3
  let acc = "";
  for (let k = 0; k < 3; k++) acc += `[${k * 2}]`;
  console.log(acc);                             // [0][2][4]
  const o = { x: 1 }; console.log(`obj=${o.x + 1}`); // obj=2
}
main();
