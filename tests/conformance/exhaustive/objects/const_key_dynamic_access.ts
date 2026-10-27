// A constant string key at a dynamic-key site (`obj[E.A]` with an enum member, `obj["lit"]`,
// `k in obj`, `obj[k] = v`) reads and writes through the named property cache with the key
// interned once; every receiver kind must agree with V8's dynamic access.
enum Flags { RAW = "__v_raw", SKIP = "__v_skip", ID = "id", LEN = "length", IDX = "0", NAME = "name", UNI = "日本語キー", EMOJI = "k\u{1F600}" }
class Point { constructor(public x: number, public y: number) {} get sum(): number { return this.x + this.y; } tag(): string { return `P(${this.x},${this.y})`; } }
function main(): void {
  const o: any = { __v_raw: 1, id: 2, "日本語キー": 3, "k\u{1F600}": 4 };
  console.log(o[Flags.RAW], o[Flags.ID], o[Flags.UNI], o[Flags.EMOJI], o[Flags.SKIP], o["__v_skip"]);
  o[Flags.SKIP] = true; o["id"] = 5; o[Flags.EMOJI] = 6;
  console.log(o[Flags.SKIP], o.id, o[Flags.EMOJI], Flags.SKIP in o, Flags.NAME in o, Flags.RAW in o);
  // arrays and strings: length, an index-like key, a method through the key
  const arr: any = [10, 20, 30];
  console.log(arr[Flags.LEN], arr[Flags.IDX], arr["push"](40), arr[Flags.LEN], arr[Flags.NAME]);
  const str: any = "hello";
  console.log(str[Flags.LEN], str[Flags.IDX], str["toUpperCase"](), str[Flags.RAW]);
  // class instances: a field, an accessor, a method; a function's own properties
  const p: any = new Point(3, 4);
  console.log(p["x"], p["sum"], p["tag"](), p[Flags.RAW], "x" in p, Flags.RAW in p);
  p[Flags.RAW] = "raw"; console.log(p[Flags.RAW], Object.getOwnPropertyDescriptor(p, Flags.RAW)?.value, p.x + p.y);
  const f: any = function named(a: number, b: number) { return a + b; };
  console.log(f[Flags.NAME], f[Flags.LEN], f["call"](null, 1, 2));
  // numbers and booleans take the prototype; null and undefined throw
  const n: any = 255; const b: any = true;
  console.log(n["toString"](16), b["valueOf"](), n[Flags.RAW]);
  for (const bad of [null, undefined] as any[]) {
    try { console.log(bad[Flags.RAW]); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
    try { bad[Flags.RAW] = 1; } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
  }
  // a Proxy sees the key as a string
  const seen: string[] = [];
  const px: any = new Proxy({ __v_raw: 7 }, {
    get(t, k, r) { seen.push("get:" + String(k)); return Reflect.get(t, k, r); },
    set(t, k, v, r) { seen.push("set:" + String(k)); return Reflect.set(t, k, v, r); },
    has(t, k) { seen.push("has:" + String(k)); return Reflect.has(t, k); },
  });
  console.log(px[Flags.RAW], (px[Flags.SKIP] = 1), Flags.RAW in px, Flags.ID in px, seen.join(" "));
  // a Record read through an absent key keeps undefined
  const d: Record<string, number> = { a: 1 };
  const v = d[Flags.RAW]; const w = d["a"];
  console.log(v, typeof v, w + 1, d[Flags.RAW] === undefined);
  // a key held in a const local, and the key site visited by several receivers
  const K = "__v_raw";
  let total = 0;
  for (let i = 0; i < 3; i++) { const objs: any[] = [o, p, px]; total += objs[i][K] ? 1 : 0; }
  console.log(total);
  // a Map's method through a constant key
  const m: any = new Map<string, number>([["a", 1]]);
  console.log(m["get"]("a"), m["has"]("b"), m["size"]);
  // an accessor defined under the key
  const g: any = {}; Object.defineProperty(g, Flags.RAW, { get() { return 42; }, configurable: true });
  console.log(g[Flags.RAW], Flags.RAW in g, typeof Object.getOwnPropertyDescriptor(g, Flags.RAW)?.get);
}
main();
