// Map<string, T> symbol-table style lookups and Set<number>.
function main(): void {
  const names: string[] = []; for (let i = 0; i < 2000; i++) names.push("sym_" + i + "_" + (i % 13));
  const table = new Map<string, number>(); const seen = new Set<number>();
  let hits = 0;
  for (let r = 0; r < 1600; r++) {
    for (let i = 0; i < names.length; i++) { const k = names[i];
      const v = table.get(k); if (v === undefined) table.set(k, i); else { hits += v; table.set(k, v + 1); }
      if (!seen.has(i & 1023)) seen.add(i & 1023); }
    if (table.has("sym_5_5")) hits++;
  }
  console.log(hits, table.size, seen.size);
}
main();
