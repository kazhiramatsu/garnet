// Sparse element storage for far stores (docs/sparse_elements_design.md): a
// store far beyond an array's capacity keeps a side table instead of
// materializing the gap. Observable behavior must match V8 exactly: length,
// reads, holes, `in`, delete, every generic operation (which densifies),
// truncation, growth back to dense storage, and GC safety of the side table.
function main(): void {
  // far store on an empty array
  const a: any[] = [];
  a[3000000] = "far";
  console.log(a.length, a[3000000], a[0], a[2999999], a[3000001], 3000000 in a, 0 in a);
  a[7] = "near";
  a[3000000] = "far2";
  console.log(a.length, a[7], a[3000000], 7 in a, 6 in a);
  a.push("pushed");
  console.log(a.length, a[3000001], a[3000002]);
  console.log(a.pop(), a.length, a.pop(), a.length, a[3000000], 2999999 in a);
  // pop on a hole at the end
  console.log(a.pop(), a.length);
  delete a[7];
  console.log(7 in a, a[7], a.length);
  a[7] = undefined;
  console.log(7 in a, a[7]);
  // truncation drops side entries; extension keeps it sparse
  a.length = 5;
  console.log(a.length, a[7], 7 in a);
  a.length = 4000000;
  console.log(a.length, a[3000000], a[3999999]);
  a[3999999] = 1;
  console.log(a.length, a[3999999]);

  // far store on an inline-backed array and on a heap-backed array
  const b: any[] = [1, 2, 3];
  b[100000] = "x";
  console.log(b.length, b[0], b[1], b[2], b[3], b[99999], b[100000], 2 in b, 3 in b);
  const c: number[] = [];
  for (let i = 0; i < 100; i++) c.push(i * 2);
  c[500000] = -1;
  console.log(c.length, c[50], c[99], c[100], c[499999], c[500000]);
  let sum = 0;
  for (let i = 0; i < 100; i++) sum += c[i];
  console.log(sum);

  // every generic operation on a sparse array
  const s: any[] = [];
  s[50000] = "e";
  s[2] = "b";
  s[40000] = "d";
  s[0] = "a";
  s[10000] = "c";
  console.log(s.join("-").length, s.indexOf("d"), s.lastIndexOf("a"), s.includes("c"), s.includes(undefined), s.indexOf(undefined));
  console.log(s.slice(9999, 10002).length, s.slice(9999, 10002).join(","), s.slice(-2).join(","));
  console.log(s.concat([1]).length, s.concat([1])[50001], s.map((v: any) => v + "!").filter((v: any) => v !== undefined).join(","));
  const seen: string[] = [];
  s.forEach((v: any, i: number) => seen.push(i + "=" + v));
  console.log(seen.join(","));
  console.log(s.reduce((acc: string, v: any) => acc + v, ""), s.some((v: any) => v === "c"), s.every((v: any) => typeof v === "string"));
  console.log(s.find((v: any) => v > "b"), s.findIndex((v: any) => v === "e"), s[50000], s[s.length - 1], s[1]);
  console.log(Object.keys(s).join(","), JSON.stringify(s).length, JSON.stringify(s.slice(0, 4)));
  const inKeys: string[] = [];
  for (const k in s) inKeys.push(k);
  console.log(inKeys.join(","));
  let ofCount = 0, ofDefined = 0;
  for (const v of s) { ofCount++; if (v !== undefined) ofDefined++; }
  console.log(ofCount, ofDefined, [...s].length, Array.from(s).length, Array.isArray(s));
  const sorted = s.slice().sort();
  console.log(sorted.length, sorted[0], sorted[4], sorted[5], 5 in sorted);
  const rev = s.slice().reverse();
  console.log(rev[0], rev[50000], 1 in rev);
  const sp = s.slice();
  const removed = sp.splice(1, 2, "X", "Y", "Z");
  console.log(removed.length, removed[1], sp.length, sp[1], sp[3], sp[50001], 50000 in sp);
  const filled = s.slice().fill(0, 49998);
  console.log(filled.length, filled[49997], filled[49998], filled[50000]);
  console.log(s.toString().length);
  // the array is dense after the generic operations: stores and reads still agree
  s[50001] = "f";
  console.log(s.length, s[50001], s.join("").length);

  // many entries make it dense again (the fast-elements heuristic): values survive
  const r: number[] = [];
  for (let i = 20000; i >= 0; i--) r[i] = i * 3;
  let ok = true;
  for (let i = 0; i <= 20000; i++) if (r[i] !== i * 3) { ok = false; break; }
  console.log(r.length, ok, r[20000], r[0]);
  const q: any[] = [];
  q[9000] = 1;
  for (let i = 0; i < 2000; i++) q[i * 4] = i;
  console.log(q.length, q[0], q[4], q[7996], q[9000], 1 in q, q.filter((v: any) => true).length);

  // length extension far beyond the capacity, then stores inside the gap
  const e: any[] = [1];
  e.length = 100000;
  console.log(e.length, e[0], e[99999], 99999 in e);
  e[50000] = 2;
  console.log(e[50000], e.length, e.indexOf(2));
  e.length = 1;
  console.log(e.length, e[50000], e[0]);

  // frozen after going sparse: strict-mode stores throw
  const f: any[] = [];
  f[200000] = 1;
  Object.freeze(f);
  try { f[1] = 2; console.log("no throw"); } catch (err: any) { console.log("throws", err instanceof TypeError); }
  try { f[200001] = 2; console.log("no throw"); } catch (err: any) { console.log("throws", err instanceof TypeError); }
  console.log(f.length, f[200000], Object.isFrozen(f));

  // dense arrays: reads beyond the length stay undefined after shrinking operations
  const d: number[] = [1, 2];
  console.log(d[2], d[3], d[100]);
  d.pop();
  console.log(d[1], d.length);
  d.push(5, 6, 7, 8);
  d.length = 0;
  console.log(d[0], d[3], d.length);
  d.push(9);
  console.log(d[0], d[1], d.length);
  const sh: number[] = [1, 2, 3];
  sh.shift();
  console.log(sh[2], sh.length, sh.join(","));
  const t: number[] = [1, 2, 3, 4, 5, 6];
  const tr = t.splice(1, 3);
  console.log(tr.length, t[3], t[4], t.length, t.join(","));
  const t2: number[] = [1, 2, 3, 4, 5, 6];
  const t2r = t2.splice(0, 5);
  console.log(t2r.length, t2[1], t2[2], t2.length, t2.join(","));
  const g: number[] = [1, 2, 3, 4, 5];
  g.length = 2;
  g.length = 5;
  console.log(g[2], g[4], 2 in g, g.join(","));

  // GC safety: young objects in the side tables of young and old arrays survive collections
  const keep: any[] = [];
  for (let round = 0; round < 20; round++) {
    const arr: any[] = [];
    arr[1000000 + round] = { id: round };
    arr[2000000] = { id: round * 10 };
    let junk: any = null;
    for (let i = 0; i < 20000; i++) junk = { i, junk: i % 2 ? null : junk };
    keep.push(arr);
  }
  let good = 0;
  for (let round = 0; round < 20; round++) {
    const arr = keep[round];
    if (arr[1000000 + round].id === round && arr[2000000].id === round * 10 && arr.length === 2000001) good++;
  }
  console.log(good);
  // an array promoted to the old generation keeps receiving young values
  const old: any[] = [];
  old[700000] = { id: -1 };
  for (let round = 0; round < 40; round++) {
    let junk: any = null;
    for (let i = 0; i < 10000; i++) junk = { i, junk: i % 2 ? null : junk };
    old[800000 + round] = { id: round, junk };
  }
  let goodOld = 0;
  for (let round = 0; round < 40; round++) if (old[800000 + round].id === round) goodOld++;
  console.log(goodOld, old[700000].id, old.length);
}
main();
