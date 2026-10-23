// Map and Set keys in every string representation: a literal, an immediate
// (short) string, a heap string built by concatenation, a slice view, a
// two-byte string, the empty string, and the same content arriving in a
// different representation at lookup; deletes leave tombstones on the probe
// path; numbers, objects, NaN and -0 keys alongside; a map below and above
// the index threshold.
function forms(s: string): string[] {
  const parts = s.split("");
  return [s, parts.join(""), ("x" + s).slice(1), (s + "y").slice(0, s.length), s.concat(""), s.toString(), `${s}`];
}
function main() {
  const out: unknown[] = [];
  for (const n of [3, 6, 40, 3000]) {
    const m = new Map<string, number>();
    const set = new Set<string>();
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      const name = i % 4 === 0 ? "k" + i : i % 4 === 1 ? "name_" + i : i % 4 === 2 ? "longerIdentifierName_" + i : "ω" + i + "λ";
      names.push(name);
      m.set(forms(name)[i % 7], i);
      set.add(forms(name)[(i + 3) % 7]);
    }
    m.set("", -1); set.add("");
    let hits = 0, sum = 0, present = 0;
    for (let i = 0; i < n; i++) {
      for (const f of forms(names[i])) {
        const v = m.get(f);
        if (v !== undefined) { hits++; sum += v; }
        if (m.has(f)) present++;
        if (set.has(f)) present++;
      }
    }
    for (let i = 0; i < n; i += 3) { m.delete(names[i]); set.delete(names[i]); }
    let after = 0;
    for (let i = 0; i < n; i++) if (m.has(("" + names[i]).slice(0))) after++;
    for (let i = 0; i < n; i++) if (set.has(names[i].split("").join(""))) after++;
    m.set("k0", 7); m.set(("" + "k0").slice(0), 8);
    out.push([n, hits, sum, present, after, m.size, set.size, m.get("k0"), m.get(""), m.has(("a" + "").slice(1)), m.get("missing")]);
  }
  const mixed = new Map<unknown, string>();
  mixed.set(1, "one"); mixed.set("1", "str one"); mixed.set(NaN, "nan"); mixed.set(-0, "zero"); mixed.set(true, "t");
  const key = {}; mixed.set(key, "obj"); mixed.set([1], "arr");
  out.push([mixed.get(1), mixed.get("1"), mixed.get(NaN), mixed.get(0), mixed.get(-0), mixed.get(true), mixed.get(key), mixed.get({}), mixed.get([1]), mixed.size]);
  console.log(JSON.stringify(out));
}
main();
