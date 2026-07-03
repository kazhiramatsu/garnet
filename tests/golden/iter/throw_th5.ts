function* inner(): Generator<number> { yield 1; yield 2; }
function* outer(): Generator<number> { yield* inner(); }
function main(): void {
  const g = outer();
  console.log(g.next().value);   // 1
  try { g.throw("boom"); } catch (e) { console.log("main caught " + e); }  // main caught boom
}

main();
