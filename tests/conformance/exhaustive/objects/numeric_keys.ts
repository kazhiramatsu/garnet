// Object literals with numeric keys: the key is its string form ("0", "1", "1.5").
function main(): void {
  const o = { 0: "a", 1: "b", length: 2 };
  console.log(Object.keys(o).length, (o as any)[0], (o as any)[1]); // 3 a b

  const n: any = { 0: "zero", 1: "one" };
  console.log(n[0], n["0"], n[1]);              // zero zero one

  const m: any = { 10: "x", a: "y", 5: "z" };
  console.log(m[10], m.a, m[5]);                // x y z

  const f: any = { 1.5: "x" };
  console.log(f[1.5], f["1.5"]);                // x x

  console.log(JSON.stringify({ 0: "a", 1: "b" })); // {"0":"a","1":"b"}
}

main();
