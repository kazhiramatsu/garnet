// Map and Set with number keys of every shape (small integers, multiples,
// negatives, halves, large ints, -0 and NaN folding, floats), mixed with
// strings and objects; lookups, misses, deletes, re-insertion and order.
function main() {
  const out: unknown[] = [];
  const m = new Map<number, number>();
  for (let i = 0; i < 300; i++) m.set(i * 8, i);
  let hits = 0, sum = 0;
  for (let i = 0; i < 2400; i++) { const v = m.get(i); if (v !== undefined) { hits++; sum += v; } }
  out.push(m.size, hits, sum, m.get(2392), m.get(2400), m.has(8), m.has(9));
  const s = new Set<number>();
  for (let i = -200; i < 200; i++) s.add(i * 0.5);
  let c = 0;
  for (let i = -500; i < 500; i++) if (s.has(i * 0.25)) c++;
  out.push(s.size, c, s.has(-0), s.has(0), s.has(99.5), s.has(100));
  const z = new Map<number, string>();
  z.set(0, "zero"); z.set(-0, "minus zero"); z.set(NaN, "nan"); z.set(0 / 0, "nan2"); z.set(1e300, "big"); z.set(2 ** 53, "two53"); z.set(-1, "m1");
  out.push(z.size, z.get(0), z.get(-0), z.get(NaN), z.get(1e300), z.get(2 ** 53), z.get(2 ** 53 + 1), z.get(-1), [...z.keys()].map(k => Object.is(k, -0) ? "-0" : String(k)).join("|"));
  const mixed = new Map<unknown, number>();
  const o1 = {}, o2 = {};
  for (let i = 0; i < 64; i++) { mixed.set(i, i); mixed.set(String(i), 100 + i); mixed.set(i + 0.5, 200 + i); }
  mixed.set(o1, 1); mixed.set(o2, 2); mixed.set(true, 3); mixed.set(null, 4); mixed.set(undefined, 5);
  let acc = 0;
  for (let i = 0; i < 64; i++) acc += (mixed.get(i) ?? 0) + (mixed.get(String(i)) ?? 0) + (mixed.get(i + 0.5) ?? 0) + (mixed.get(i + 0.25) ?? 0);
  out.push(mixed.size, acc, mixed.get(o1), mixed.get(o2), mixed.get({}), mixed.get(true), mixed.get(null), mixed.get(undefined), mixed.get("7"), mixed.get(7));
  for (let i = 0; i < 300; i += 3) m.delete(i * 8);
  out.push(m.size, m.get(0), m.get(8), m.get(24), m.has(48));
  for (let i = 0; i < 300; i += 3) m.set(i * 8, -i);
  out.push(m.size, m.get(0), m.get(24), [...m.keys()].slice(0, 5).join(","), [...m.keys()].slice(-3).join(","));
  const big = new Map<number, number>();
  for (let i = 1; i <= 20000; i++) big.set(i * 37 % 100003, i);
  let bs = 0;
  for (let i = 1; i <= 20000; i++) bs += big.get(i * 37 % 100003)!;
  out.push(big.size, bs, big.get(37), big.get(38));
  console.log(JSON.stringify(out));
}
main();
