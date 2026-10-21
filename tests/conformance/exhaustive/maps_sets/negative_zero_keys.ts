// Map.prototype.set and Set.prototype.add store a -0 key as +0 (ECMA-262
// 24.1.3.9, 24.2.3.1), so iteration yields +0, in the scan mode (a few keys)
// and the indexed mode (many keys). Lookups match the slot index's hash bits
// first: keys whose hashes share the slot bits (strided numbers), strings of
// equal content built apart, object keys, NaN, and "" after a deleted "" (a
// deleted entry is a hole, which must not equal "").
function inv(x: number): string { return Object.is(x, -0) ? "-0" : String(x); }
function main(): void {
  for (const n of [1, 20]) {
    const m = new Map<number, number>();
    m.set(-0, 1);
    for (let i = 1; i < n; i++) m.set(i, i);
    const first = [...m.keys()][0];
    m.forEach((v, k) => { if (v === 1 && n === 1) console.log("forEach key", inv(k)); });
    console.log(n, inv(first), m.get(0), m.get(-0), m.has(0), m.size);
    m.set(0, 5);
    console.log(m.size, m.get(-0), inv([...m.entries()][0][0]));
    console.log(m.delete(-0), m.has(0), m.size);
    const s = new Set<number>();
    s.add(-0);
    for (let i = 1; i < n; i++) s.add(i);
    console.log(inv([...s][0]), s.has(0), s.has(-0), s.size);
    s.add(0);
    console.log(s.size, s.delete(0), s.has(-0));
  }
  const viaCtor = new Map<number, string>([[-0, "z"]]);
  console.log(inv([...viaCtor.keys()][0]), viaCtor.get(0));
  const setCtor = new Set<number>([-0, 0]);
  console.log(setCtor.size, inv([...setCtor][0]));
  // strided keys: equal low bits, distinct hashes
  const strided = new Map<number, number>();
  for (let i = 0; i < 3000; i++) strided.set(i * 65536, i);
  let sum = 0, misses = 0;
  for (let i = 0; i < 3000; i++) sum += strided.get(i * 65536)!;
  for (let i = 0; i < 3000; i++) if (!strided.has(i * 65536 + 1)) misses++;
  console.log(strided.size, sum, misses);
  // strings of equal content built apart, objects, NaN
  const words = new Map<string, number>();
  for (let i = 0; i < 40; i++) words.set("w" + i, i);
  let found = 0;
  for (let i = 0; i < 40; i++) if (words.get(["w", String(i)].join("")) === i) found++;
  console.log(found, words.has("w40"), words.get("w" + "1" + "2"));
  const objs: object[] = [];
  const om = new Map<object, number>();
  for (let i = 0; i < 30; i++) { const o = { i }; objs.push(o); om.set(o, i); }
  console.log(om.get(objs[17]), om.has({ i: 17 }), om.size);
  const nm = new Map<number, string>([[NaN, "nan"]]);
  for (let i = 0; i < 12; i++) nm.set(i / 3, "f" + i);
  console.log(nm.get(0 / 0), nm.get(Number("x")), nm.get(1 / 3), nm.size);
  // "" after a deleted "" (scan and indexed modes)
  for (const n of [0, 30]) {
    const e = new Map<string, number>();
    for (let i = 0; i < n; i++) e.set("k" + i, i);
    e.set("", 1);
    e.delete("");
    console.log(e.get(""), e.has(""), e.size);
    e.set("", 2);
    console.log(e.get(""), e.size, [...e.keys()].indexOf(""));
    const es = new Set<string>(["a", ""]);
    es.delete("");
    console.log(es.has(""), es.size);
  }
}
main();
