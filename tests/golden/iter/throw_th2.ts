function* g(): Generator<number> { yield 1; yield 2; }
function main(): void {
  const it = g();
  console.log(it.next().value);   // 1
  try { it.throw("boom"); } catch (e) { console.log("outer caught " + e); }  // outer caught boom
}

main();
