// GC bench: Map/Set churn（ハッシュ索引の回帰検出用）。
// 4096/2048 キー規模で set/delete を繰り返し、RT_STATS の map_find
// 平均プローブ長が要素数に比例して再び増えていないことを確認する。
function main(): void {
  const m = new Map<number, number>();
  let acc = 0;
  for (let i = 0; i < 400000; i++) {
    m.set(i & 4095, i);
    if ((i & 7) === 0) m.delete((i * 3) & 4095);
    if ((i & 1023) === 0) acc += m.size;
  }
  const s = new Set<number>();
  for (let i = 0; i < 400000; i++) {
    s.add(i & 2047);
    if ((i & 3) === 0) s.delete((i * 5) & 2047);
  }
  console.log("gc_mapset_churn " + (acc + m.size + s.size));
}
main();
