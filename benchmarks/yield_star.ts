function* a(): Generator<number> { yield 1; yield 2; }
function* b(): Generator<number> { yield 0; yield* a(); yield 3; }
function* c(): Generator<number> { yield* b(); yield 4; }
function main(): void {
  let out = "";
  for (const x of c()) { out = out + x + ","; }
  console.log(out);   // 0,1,2,3,4,
}

main();
