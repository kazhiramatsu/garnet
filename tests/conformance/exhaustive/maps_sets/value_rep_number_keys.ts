// Number keys of Maps and Sets through the typed lookups (a number local, the indexed table's probe in
// line) and the generic ones: -0 is stored and found as +0, and NaN is one key that is no zero
// (representation 1 makes the word of -0 the canonical NaN's: docs/unmasked_pointers_design.md, section 4).
function show(x: number): string { return Object.is(x, -0) ? "-0" : String(x); }
function main(): void {
  for (const n of [3, 40]) {
    const m = new Map<number, string>();
    let nz = -0, nan = NaN, z = 0;
    for (let i = 0; i < n; i++) { m.set(i + 0.25, "q" + i); nz = nz * 1; z = z + 0; nan = nan * 2; }
    m.set(nan, "nan");
    m.set(nz, "negzero");
    console.log(n, m.get(nan), m.get(0 / 0), m.get(z), m.get(nz), m.get(-0), m.has(NaN), m.has(0), m.size);
    m.set(z, "zero");
    m.set(Math.sqrt(-1), "nan2");
    const ks = [...m.keys()];
    console.log(m.get(-0), m.get(NaN), m.size, ks.slice(-2).map(show).join(","));
    console.log(m.delete(nz), m.has(0), m.delete(nan), m.has(NaN), m.size);
    const s = new Set<number>();
    for (let i = 0; i < n; i++) s.add(i * 1.5);
    s.add(nz); s.add(nan); s.add(z); s.add(NaN);
    console.log(s.has(-0), s.has(0), s.has(NaN), s.has(nan), s.size, [...s].slice(-2).map(show).join(","));
    console.log(s.delete(nz), s.has(0), s.delete(NaN), s.has(nan), s.size);
    const anyMap: any = new Map<number, number>([[nz, 1], [nan, 2]]);
    console.log(anyMap.get(0), anyMap.get(-0), anyMap.get(NaN), anyMap.has(z), anyMap.size, [...anyMap.keys()].map(show).join(","));
  }
}
main();
