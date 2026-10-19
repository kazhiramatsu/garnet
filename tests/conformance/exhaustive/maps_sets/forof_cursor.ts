// for..of over a Map or Set is driven by a cursor over the collection
// (docs/map_cursor_forof_design.md): no iterator object, no result objects, no
// pair arrays for a `[k, v]` pattern. Every observable result must match V8:
// insertion order, entries added during the loop (visited), deleted ones
// (skipped), the current entry deleted and re-added (visited again at the
// end), clear() in the loop, keys()/values()/entries() on both collections,
// destructuring with defaults, holes and rest (the pair path), a plain
// variable receiving the pair, assignment targets, nested loops over the same
// map, break/continue, closures capturing the loop variable, large maps (the
// indexed mode), number keys, and a non-collection receiver (TypeError).
function main(): void {
  const m = new Map<string, number>([["a", 1], ["b", 2], ["c", 3]]);
  const out: string[] = [];
  for (const [k, v] of m) out.push(k + "=" + v);
  for (const k of m.keys()) out.push(k);
  for (const v of m.values()) out.push(String(v));
  for (const [k, v] of m.entries()) out.push(k + v);
  for (const pair of m) out.push(pair.length + ":" + pair[0] + pair[1]);
  console.log(out.join(" "));
  // mutation during the loop: add, delete the current, delete a later one, re-add
  const seen: string[] = [];
  for (const [k, v] of m) {
    seen.push(k + v);
    if (k === "a") { m.set("d", 4); m.delete("b"); }
    if (k === "c") { m.delete("c"); m.set("c", 33); }
    if (seen.length > 20) break;
  }
  console.log(seen.join(" "), [...m.keys()].join(","), m.size);
  // clear in the loop
  const m2 = new Map<number, string>([[1, "x"], [2, "y"], [3, "z"]]);
  const seen2: number[] = [];
  for (const [k] of m2) { seen2.push(k); if (k === 2) m2.clear(); }
  m2.set(9, "w");
  for (const [k] of m2) seen2.push(k);
  console.log(seen2.join(","), m2.size);
  // sets: values, keys, entries, mutation
  const s = new Set<string>(["p", "q", "r"]);
  const sv: string[] = [];
  for (const x of s) sv.push(x);
  for (const x of s.keys()) sv.push(x.toUpperCase());
  for (const [a, b] of s.entries()) sv.push(a + b);
  for (const x of s) { if (x === "p") { s.add("t"); s.delete("q"); } sv.push("#" + x); }
  console.log(sv.join(" "), [...s].join(","));
  // destructuring forms through the pair path: defaults, holes, rest, nested
  const mm = new Map<string, number[]>([["u", [1, 2]], ["w", [3]]]);
  const forms: string[] = [];
  for (const [k, [first, second = -1]] of mm) forms.push(k + first + second);
  for (const [, v] of mm) forms.push("v" + v.length);
  for (const [k, ...rest] of mm) forms.push(k + rest.length);
  for (const [k = "dflt", v] of mm) forms.push(k + v[0]);
  let key = "", val: number[] = [];
  for ([key, val] of mm) forms.push(key + val.join("+"));
  let pairVar: [string, number[]] | undefined;
  for (pairVar of mm) forms.push(pairVar[0]);
  console.log(forms.join(" "));
  // nested loops over the same map, break and continue
  const nested: string[] = [];
  for (const [k1] of m) { for (const [k2] of m) { if (k2 === "c") continue; if (k1 === "d") break; nested.push(k1 + k2); } }
  console.log(nested.join(" "));
  // closures capturing the loop variables (a fresh binding per iteration)
  const fns: (() => string)[] = [];
  for (const [k, v] of m) fns.push(() => k + ":" + v);
  for (const x of s) fns.push(() => x + "!");
  console.log(fns.map((f) => f()).join(" "));
  // large collections (indexed mode) with deletions and number keys
  const big = new Map<number, number>();
  for (let i = 0; i < 5000; i++) big.set(i * 3, i);
  for (let i = 0; i < 5000; i += 7) big.delete(i * 3);
  let sum = 0, count = 0, last = -1;
  for (const [k, v] of big) { sum += k + v; count++; last = k; }
  const bigSet = new Set<number>();
  for (let i = 0; i < 3000; i++) bigSet.add(i % 1000);
  let ssum = 0;
  for (const x of bigSet) ssum += x;
  console.log(sum, count, last, big.size, ssum, bigSet.size);
  // a receiver that is not a collection at runtime: a loud TypeError
  const fake = { size: 1 } as unknown as Map<string, number>;
  try { for (const [k] of fake) console.log("no throw", k); } catch (err: any) { console.log("throws", err instanceof TypeError); }
}
main();
