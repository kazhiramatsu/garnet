// Map with small integer keys (node ids, symbol ids): the runtime indexes such a
// map directly by key instead of hashing. Dense and sparse keys, growth, deletes
// past the compaction threshold, re-insertion, a string key arriving (the direct
// index gives way to the hash index), -0, NaN and fractions, clear and reuse,
// insertion order through all of it, against V8.
function main(): void {
  const m = new Map<number, number>();
  for (let i = 0; i < 5000; i++) m.set(i * 2, i);
  let hits = 0, sum = 0;
  for (let i = 0; i < 10000; i++) { const v = m.get(i); if (v !== undefined) { hits++; sum += v; } }
  console.log("dense", m.size, hits, sum, m.has(9998), m.has(9999), m.get(0), m.get(-0), m.get(1.5), m.get(NaN));
  // deletes past the compaction threshold, then lookups and re-inserts
  for (let i = 0; i < 5000; i++) if (i % 3 !== 0) m.delete(i * 2);
  let live = 0; for (let i = 0; i < 10000; i++) if (m.has(i)) live++;
  console.log("deleted", m.size, live, m.get(6), m.get(8), m.delete(8), m.delete(1234567));
  for (let i = 0; i < 100; i++) m.set(i * 2 + 1, -i);
  const order: number[] = []; for (const [k] of m) order.push(k); 
  console.log("reinsert", m.size, order.length, order.slice(0, 5).join(","), order.slice(-3).join(","), m.get(199), m.get(1));
  // a string key: the map leaves the direct form; everything stays
  const mixed = new Map<number | string, string>();
  for (let i = 0; i < 300; i++) mixed.set(i, "v" + i);
  mixed.set("name", "s"); mixed.set(1000000, "far"); mixed.set(-1, "neg"); mixed.set(2.5, "half"); mixed.set(NaN, "nan"); mixed.set(-0, "zero");
  console.log("mixed", mixed.size, mixed.get(299), mixed.get("name"), mixed.get(1000000), mixed.get(-1), mixed.get(2.5), mixed.get(NaN), mixed.get(0), [...mixed.keys()].slice(298, 303).join("|"));
  // sparse ids from the start: never direct; same semantics
  const sparse = new Map<number, number>();
  for (let i = 0; i < 64; i++) sparse.set(i * 100003, i);
  let s = 0; for (let i = 0; i < 64; i++) s += sparse.get(i * 100003)!;
  console.log("sparse", sparse.size, s, sparse.has(100003), sparse.has(100004));
  // growth from small keys to a far key within the density rule, and one past it
  const grow = new Map<number, boolean>();
  for (let i = 0; i < 1000; i++) grow.set(i, true);
  grow.set(3000, true); grow.set(50000, true);
  console.log("grow", grow.size, grow.get(3000), grow.get(50000), grow.get(2999), grow.get(999));
  // clear and reuse, with a negative zero key and iteration order
  grow.clear(); grow.set(-0, false); grow.set(7, true); grow.set(3, true);
  console.log("cleared", grow.size, grow.get(0), [...grow.keys()].join(","), Object.is([...grow.keys()][0], 0));
  // a large id range as the checker uses: ids in [1, 2^21), 20% occupied
  const links = new Map<number, number>();
  for (let id = 1; id < 2097152; id += 5) links.set(id, id & 1023);
  let acc = 0; for (let id = 1; id < 2097152; id += 7) { const v = links.get(id); if (v !== undefined) acc = (acc + v) | 0; }
  console.log("links", links.size, acc, links.has(2097146), links.has(2097147));
}
main();
