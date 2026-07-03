// GC bench: 短命オブジェクト churn（nursery 回収の支配ケース）。
// 64 要素リングに書き込んで必ずヒープへエスケープさせる（SROA/stack 化を防ぐ）。
function main(): void {
  const ring: ({ a: number; b: number } | null)[] = [];
  for (let i = 0; i < 64; i++) ring.push(null);
  let acc = 0;
  for (let i = 0; i < 3000000; i++) {
    const o = { a: i, b: i * 2 };
    ring[i & 63] = o;
    const p = ring[(i * 7) & 63];
    if (p !== null) acc = (acc + p.a + p.b) % 1000000007;
  }
  console.log("gc_shortlived " + acc);
}
main();
