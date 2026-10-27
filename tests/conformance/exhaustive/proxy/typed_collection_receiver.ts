// Typed Map and Set operations (the receiver's static type is a Map or a Set) through a Proxy whose get
// trap returns instrumented methods, as vue's collection handlers do: get/set/has/delete/size/forEach,
// the iterators and the cursor-driven for..of all go through the trap.
function main(): void {
  const log: string[] = [];
  const rawM = new Map<string, number>([["a", 1]]);
  const instr: Record<string, Function> = {
    get(this: Map<string, number>, k: string) { log.push("mget:" + k); return rawM.get(k); },
    set(this: Map<string, number>, k: string, v: number) { log.push("mset:" + k); rawM.set(k, v); return this; },
    has(this: Map<string, number>, k: string) { log.push("mhas:" + k); return rawM.has(k); },
    delete(this: Map<string, number>, k: string) { log.push("mdel:" + k); return rawM.delete(k); },
    forEach(this: Map<string, number>, cb: (v: number, k: string) => void) { log.push("mforEach"); rawM.forEach((v, k) => cb(v, k)); },
    clear() { log.push("mclear"); rawM.clear(); },
    keys() { log.push("mkeys"); return rawM.keys(); },
    values() { log.push("mvalues"); return rawM.values(); },
    entries() { log.push("mentries"); return rawM.entries(); },
    [Symbol.iterator]() { log.push("miter"); return rawM[Symbol.iterator](); },
  };
  const m: Map<string, number> = new Proxy(rawM, {
    get(t, k, r) { if (k === "size") { log.push("msize"); return t.size; } const f = instr[k as string]; if (f) return f; return Reflect.get(t, k, r); },
  });
  m.set("b", 2); m.set("c", 3);
  console.log("get", m.get("a"), m.get("zz"), "has", m.has("b"), m.has("q"), "size", m.size, log.length);
  let t = 0; m.forEach((v) => { t += v; }); console.log("forEach", t, log.length);
  const ks: string[] = []; for (const [k, v] of m) ks.push(k + v); console.log("forof", ks.join(","), log.length);
  console.log("keys", [...m.keys()].join(","), "values", [...m.values()].join(","), "entries", [...m.entries()].length, log.length);
  console.log("delete", m.delete("a"), m.delete("zz"), m.size, log.length);
  console.log("spread", [...m].length, "from", Array.from(m).length, log.length);
  const rawS = new Set<number>([1]);
  const sinstr: Record<string, Function> = {
    add(this: Set<number>, v: number) { log.push("sadd:" + v); rawS.add(v); return this; },
    has(this: Set<number>, v: number) { log.push("shas:" + v); return rawS.has(v); },
    delete(this: Set<number>, v: number) { log.push("sdel:" + v); return rawS.delete(v); },
    forEach(this: Set<number>, cb: (v: number) => void) { log.push("sforEach"); rawS.forEach((v) => cb(v)); },
    values() { log.push("svalues"); return rawS.values(); },
    [Symbol.iterator]() { log.push("siter"); return rawS[Symbol.iterator](); },
  };
  const s: Set<number> = new Proxy(rawS, {
    get(t, k, r) { if (k === "size") { log.push("ssize"); return t.size; } const f = sinstr[k as string]; if (f) return f; return Reflect.get(t, k, r); },
  });
  s.add(2); s.add(3);
  console.log("has", s.has(2), s.has(9), "size", s.size, log.length);
  let u = 0; s.forEach((v) => { u += v; }); console.log("sforEach", u, log.length);
  const vs: number[] = []; for (const v of s) vs.push(v); console.log("sforof", vs.join(","), log.length);
  console.log("svalues", [...s.values()].join(","), "sspread", [...s].join(","), "sdelete", s.delete(1), s.size, log.length);
  console.log(log.join(" "));
}
main();
