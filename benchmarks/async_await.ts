async function double(x: number): Promise<number> { return x * 2; }
async function compute(): Promise<number> {
  let sum = 0;
  const a = await double(5);    // 10
  sum = sum + a;
  const b = await double(a);    // 20
  sum = sum + b;
  return sum;                   // 30
}
async function main(): Promise<void> {
  console.log("start");
  const r = await compute();
  console.log(r);               // 30
  console.log("end");
}

main();
