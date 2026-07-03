function* inner(): Generator<number> {
  try { yield 1; yield 2; } catch (e) { console.log("inner caught " + e); yield 99; }
}
function* outer(): Generator<number> { yield* inner(); }
function main(): void {
  const g = outer();
  console.log(g.next().value);     // 1
  console.log(g.throw("boom").value);  // inner caught boom, 99
}

main();
