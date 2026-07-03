function* g(): Generator<number> {
  try { yield 1; yield 2; } finally { console.log("cleanup"); }
}
function main(): void {
  const it = g();
  console.log(it.next().value);   // 1
  try { it.throw("x"); } catch (e) { console.log("caught " + e); }  // cleanup, caught x
}

main();
