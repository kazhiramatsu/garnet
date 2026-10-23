// A symbol table's lookups, as a checker does them: a Map<string, T> of
// identifiers, looked up with keys of equal content but built elsewhere (a
// different string object per occurrence), short names and long ones mixed.
function main() {
  const n = 20000;
  const table = new Map<string, number>();
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = i % 3 === 0 ? "v" + i : i % 3 === 1 ? "name_" + i : "someLongerIdentifierName_" + i;
    table.set(name, i);
    names.push(name);
  }
  // the lookup keys: equal content, distinct objects
  const probes: string[] = [];
  for (let i = 0; i < n; i++) probes.push(names[(i * 7919) % n].slice(0));
  let hits = 0;
  let sum = 0;
  for (let rep = 0; rep < 400; rep++) {
    for (let i = 0; i < n; i++) {
      const v = table.get(probes[i]);
      if (v !== undefined) { hits++; sum = (sum + v) | 0; }
    }
  }
  console.log(hits, sum, table.size);
}
main();
