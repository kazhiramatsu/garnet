// Interfaces extending Map/ReadonlyMap/Set (the compiler's MultiMap<K, V>
// extends Map<K, V[]>) take the Map/Set builtins instead of the dynamic method
// dispatch; a receiver that is not a Map/Set at run time throws the TypeError
// V8 throws for a Map method on an incompatible receiver. Every result must
// match V8: get/set/has/delete/size/clear/forEach, keys/values/entries and
// for..of through the interface, a derived interface of a derived interface,
// a readonly view, and the incompatible receivers.
interface MultiMap<K, V> extends Map<K, V[]> {
  add(key: K, value: V): V[];
  remove(key: K, value: V): void;
}
function createMultiMap<K, V>(): MultiMap<K, V> {
  const map = new Map<K, V[]>() as MultiMap<K, V>;
  map.add = function (this: MultiMap<K, V>, key: K, value: V) {
    let values = this.get(key);
    if (values) values.push(value); else this.set(key, values = [value]);
    return values;
  };
  map.remove = function (this: MultiMap<K, V>, key: K, value: V) {
    const values = this.get(key);
    if (values) { const i = values.indexOf(value); if (i >= 0) values.splice(i, 1); if (!values.length) this.delete(key); }
  };
  return map;
}
interface TagMap extends MultiMap<string, number> { label: string; }
interface Counts extends ReadonlyMap<string, number> { total: number; }
interface IdSet extends Set<number> { origin: string; }
function countOf(c: Counts, k: string): number { return (c.get(k) ?? 0) + c.size; }
function main(): void {
  const mm = createMultiMap<string, number>();
  mm.add("a", 1); mm.add("a", 2); mm.add("b", 3);
  console.log(mm.size, mm.has("a"), mm.has("z"), mm.get("a")?.join("+"), mm.get("z"));
  mm.remove("a", 1); mm.remove("b", 3);
  console.log(mm.size, [...mm.keys()].join(","), mm.get("a")?.join("+"), mm.delete("a"), mm.delete("a"), mm.size);
  const tags = createMultiMap<string, number>() as TagMap;
  tags.label = "L"; tags.add("x", 9); tags.set("y", [7, 8]);
  const seen: string[] = [];
  tags.forEach((v, k) => seen.push(k + ":" + v.join("/")));
  for (const [k, v] of tags) seen.push(k + "=" + v.length);
  for (const k of tags.keys()) seen.push(k.toUpperCase());
  for (const v of tags.values()) seen.push(String(v[0]));
  for (const [k, v] of tags.entries()) seen.push(k + v.length);
  console.log(seen.join(" "), tags.label, tags.size);
  tags.clear();
  console.log(tags.size, tags.get("x"), tags.label);
  const counts = new Map<string, number>([["p", 2], ["q", 5]]) as unknown as Counts;
  (counts as any).total = 7;
  console.log(countOf(counts, "p"), countOf(counts, "r"), counts.total, [...counts.entries()].map((e) => e.join("~")).join(","));
  const ids = new Set<number>([3, 1, 2]) as IdSet;
  ids.origin = "o"; ids.add(5); ids.delete(1);
  console.log(ids.size, ids.has(2), ids.has(1), [...ids].join(","), ids.origin);
  ids.forEach((v) => seen.push("s" + v));
  console.log(seen.slice(-3).join(" "));
  // incompatible receivers through the interface: TypeError, as in V8 (V8 fails
  // to call the missing method; the builtin rejects the receiver; `.size` on a
  // lying type is left out: V8 reads a plain property there, garnet throws)
  const fakeMap = { size: 1, get: undefined } as unknown as MultiMap<string, number>;
  const fakeSet = {} as unknown as IdSet;
  for (const f of [() => fakeMap.get("a"), () => fakeMap.has("a"), () => fakeMap.set("a", []), () => fakeMap.delete("a"), () => fakeSet.add(1), () => fakeSet.has(1), () => fakeMap.forEach(() => {})]) {
    try { f(); console.log("no throw"); } catch (err: any) { console.log("throws", err instanceof TypeError); }
  }
  let total = 0;
  const big = createMultiMap<number, number>();
  for (let i = 0; i < 20000; i++) big.add(i % 100, i);
  for (let i = 0; i < 100; i++) total += big.get(i)!.length + (big.has(i) ? 1 : 0);
  console.log(total, big.size);
}
main();
