async function fetchVal(i: number): Promise<number> { return i * 10; }
async function* pipeline(n: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i++) {
    const v = await fetchVal(i);   // await inside async generator
    yield v + 1;                   // then yield
  }
}
async function main(): Promise<void> {
  let out = "";
  for await (const x of pipeline(4)) {
    out = out + x + ",";
  }
  console.log(out);   // 1,11,21,31,
}

main();
