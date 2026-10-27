// The generic Array.prototype mutators (push, pop, shift, unshift, splice) and iterators over an array-like
// object and over a Proxy around an array (the elements and the length are properties: a Proxy's traps see
// every step), and the Map/Set prototype methods rejecting a Proxy receiver.
function main(): void {
  const o: { length: number; [k: number]: string } = { length: 2, 0: "a", 1: "b" };
  const push = Array.prototype.push, pop = Array.prototype.pop, shift = Array.prototype.shift, unshift = Array.prototype.unshift, splice = Array.prototype.splice;
  console.log(push.call(o, "c", "d"), o.length, o[2], o[3]);
  console.log(pop.call(o), o.length, 3 in o);
  console.log(shift.call(o), o.length, o[0], o[1], 2 in o);
  console.log(unshift.call(o, "x", "y"), o.length, o[0], o[1], o[2], o[3]);
  console.log(JSON.stringify(splice.call(o, 1, 2, "m")), o.length, o[0], o[1], o[2]);
  console.log(JSON.stringify(splice.call(o, 1)), o.length, JSON.stringify(splice.call(o, 0, 0, "q", "r")), o.length, o[0], o[1], o[2]);
  const vals = Array.prototype.values.call(o) as IterableIterator<string>;
  console.log([...vals].join(","), [...(Array.prototype.entries.call(o) as IterableIterator<[number, string]>)].length);
  const log: string[] = [];
  const raw = [1, 2, 3];
  const p = new Proxy(raw, { set(t, k, v, r) { log.push("set:" + String(k) + "=" + String(v)); return Reflect.set(t, k, v, r); }, deleteProperty(t, k) { log.push("del:" + String(k)); return Reflect.deleteProperty(t, k); } });
  console.log(push.apply(p, [4, 5]), raw.join(","), pop.call(p), shift.call(p), raw.join(","), unshift.call(p, 0), raw.join(","));
  console.log(JSON.stringify(splice.call(p, 1, 2, 9, 8, 7)), raw.join(","), log.join(" "));
  const tm = new Proxy(new Map<string, number>([["a", 1]]), {});
  try { tm.get("a"); console.log("no throw"); } catch (e) { console.log("map proxy:", (e as Error).constructor.name); }
  const ts = new Proxy(new Set<number>([1]), {});
  try { ts.has(1); console.log("no throw"); } catch (e) { console.log("set proxy:", (e as Error).constructor.name); }
  const ta = new Proxy([1, 2], {});
  console.log(Array.isArray(ta), Array.isArray(tm), ta.length, ta.map((v) => v * 2).join(","), [...ta].join(","));
  const out: number[] = []; for (const v of ta) out.push(v); console.log(out.join(","));
}
main();
