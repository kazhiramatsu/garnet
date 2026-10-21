// Element access whose receiver is not what its static type says (a value
// cast to an array): an object is read and written by the index as a
// property (getters run), null and undefined throw, a write to another
// primitive throws as strict code does. These used to read undefined and
// drop the write.
function first(a: number[]): unknown { const x: unknown = a[0]; return x; }
function put(a: number[], v: number): void { a[1] = v; }
function at(a: string[], i: number): unknown { const x: unknown = a[i]; return x; }
function report(label: string, f: () => unknown): void {
  try { console.log(label, f()); }
  catch (e) { console.log(label, "threw", (e as Error).constructor.name, (e as Error).message); }
}
report("object", () => { const o: any = { 0: 7, 1: 8 }; put(o, 9); return [first(o), o[1]].join(); });
report("object far key", () => { const o: any = {}; o[4294967295] = "far"; return at(o, 4294967295); });
report("object fractional key", () => { const o: any = { "1.5": "half" }; return at(o, 1.5); });
report("getter", () => { const o = {}; Object.defineProperty(o, 0, { get() { return 42; } }); return first(o as number[]); });
report("setter", () => { let seen = 0; const o = {}; Object.defineProperty(o, 1, { set(v: number) { seen = v; } }); put(o as number[], 5); return seen; });
report("map", () => { const m: any = new Map(); put(m, 3); return m[1]; });
report("null read", () => first(null as unknown as number[]));
report("undefined read", () => first(undefined as unknown as number[]));
report("null write", () => put(null as unknown as number[], 1));
report("undefined write", () => put(undefined as unknown as number[], 1));
report("number write", () => put(5 as unknown as number[], 1));
report("boolean write", () => put(true as unknown as number[], 1));
report("string write", () => put("abc" as unknown as number[], 1));
report("string write past", () => put("a" as unknown as number[], 1));
report("string read", () => at("abc" as unknown as string[], 1));
report("array", () => { const a = [1, 2]; put(a, 3); return [first(a), a[1]].join(); });
