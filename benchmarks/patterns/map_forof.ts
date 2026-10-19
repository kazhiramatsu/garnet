// for..of over Map and Set: entries with a [k, v] pattern, keys(), values(),
// and a Set, with insertions during the loop (the protocol's view of mutation).
function main(): void {
  const m = new Map<number, number>();
  for (let i = 0; i < 2000; i++) m.set(i, i * 2);
  const s = new Set<number>();
  for (let i = 0; i < 2000; i++) s.add(i * 3);
  let sum = 0;
  for (let round = 0; round < 400; round++) {
    for (const [k, v] of m) sum += k + v;
    for (const k of m.keys()) sum += k;
    for (const v of m.values()) sum -= v;
    for (const x of s) sum += x;
    if (round % 100 === 0) { m.set(2000 + round, round); s.add(-round); }
  }
  console.log(sum, m.size, s.size);
}
main();
