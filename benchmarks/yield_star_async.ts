async function* inner(): AsyncGenerator<number> { yield 10; yield 20; }
async function* outer(): AsyncGenerator<number> {
  yield 5;
  yield* inner();
  yield 30;
}
async function main(): Promise<void> {
  let out = "";
  for await (const x of outer()) { out = out + x + ","; }
  console.log(out);   // 5,10,20,30,
}

main();
