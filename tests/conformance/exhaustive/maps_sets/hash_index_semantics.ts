// Map/Set ハッシュ索引 (P2a) の回帰網: SameValueZero 意味論（NaN 同一・±0 同一・
// オブジェクト identity・別経路生成の同内容文字列）、索引経路（>8 エントリ）と
// tombstone/compaction（大量 delete）、挿入順保存（削除→再追加は末尾）、
// forEach 反復中 delete の V8 準拠スキップ、spread/keys/values/entries の hole 除外、
// clear 後の索引再利用。
function main(): void {
  // 基本 + 大規模（索引経路）+ NaN/-0 意味論
  const m = new Map<any, number>();
  m.set(NaN, 1); m.set(NaN, 2);            // SameValueZero: 同一キー
  m.set(0, 10); m.set(-0, 20);             // ±0 同一
  console.log(m.size, m.get(NaN), m.get(0));
  const o1 = { a: 1 }, o2 = { a: 1 };
  m.set(o1, 100); m.set(o2, 200);          // identity: 別キー
  console.log(m.size, m.get(o1), m.get(o2), m.has({ a: 1 }));
  const k1 = "ab" + String(1), k2 = "a" + "b1"; // 別経路で作った同内容文字列
  m.set(k1, 7); console.log(m.get(k2), m.has("ab1"));
  // 大規模 churn（索引 + tombstone + compaction）
  const big = new Map<number, number>();
  for (let i = 0; i < 5000; i++) big.set(i, i * 2);
  for (let i = 0; i < 5000; i += 2) big.delete(i);
  console.log(big.size, big.get(1), big.get(2), big.has(4998), big.get(4999));
  for (let i = 0; i < 5000; i += 2) big.set(i, i * 3); // 再追加（順序は末尾）
  console.log(big.size, big.get(0), big.get(4998));
  // 挿入順の保存（削除→再追加は末尾へ）
  const ord = new Map<string, number>();
  ord.set("a", 1); ord.set("b", 2); ord.set("c", 3);
  ord.delete("b"); ord.set("b", 9);
  console.log(JSON.stringify([...ord]));
  console.log(JSON.stringify([...ord.keys()]), JSON.stringify([...ord.values()]));
  // forEach + 反復中 delete（後続キーの visit スキップ）
  const fe = new Map<string, number>();
  fe.set("x", 1); fe.set("y", 2); fe.set("z", 3);
  const seen: string[] = [];
  fe.forEach((v, k) => { seen.push(k); if (k === "x") fe.delete("y"); });
  console.log(JSON.stringify(seen), fe.size);
  // Set 側
  const s = new Set<any>();
  s.add(NaN); s.add(NaN); s.add(0); s.add(-0); s.add("q");
  console.log(s.size, s.has(NaN), s.has(-0));
  const sb = new Set<number>();
  for (let i = 0; i < 3000; i++) sb.add(i % 1000);
  for (let i = 0; i < 500; i++) sb.delete(i);
  console.log(sb.size, sb.has(499), sb.has(500), JSON.stringify([...sb].slice(0, 3)));
  // clear 後の再利用
  ord.clear(); console.log(ord.size, ord.get("a"));
  ord.set("zz", 5); console.log(ord.size, ord.get("zz"));
}
main();
