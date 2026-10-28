// One `obj[key]` site reading several keys of the same shape (hono's `matchers[method]`, a trie's
// `children[part]`): the site's inline cache answers a key only with an entry for that key and shape
// (a shape match alone names the slot of another key). Hits and misses interleaved, two shapes,
// integer slots, accessors, frozen and null-prototype receivers, arrays with named properties, index
// strings on arrays, immediate and heap keys, keys that are slices, and the megamorphic site.
function show(label: string, v: unknown): void { console.log(label, JSON.stringify(v)); }
function read(o: any, k: string): unknown { return o[k]; }
function main(): void {
  const routes: Record<string, number> = { GET: 1, POST: 2, PUT: 3, DELETE: 4, PATCH: 5 };
  const out: unknown[] = [];
  for (let i = 0; i < 40; i++) for (const k of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "GET"]) out.push(read(routes, k));
  show("routes", [out.slice(0, 7), out.slice(-7), out.length]);
  const shapeA = { user: "a-user", event: "a-event", map: "a-map" };
  const shapeB = { user: "b-user", map: "b-map", event: "b-event", extra: 1 };
  const keys = ["user", "event", "map", "static", "user", "map"];
  const r2: unknown[] = [];
  for (let i = 0; i < 20; i++){ const o = i % 2 ? shapeA : shapeB; for (const k of keys) r2.push(read(o, k)); }
  show("two shapes", [r2.slice(0, 12), r2.length]);
  const ints = { a: 1, b: 2, c: 3 }; ints.a = 10; ints.b = 20;
  show("ints", [read(ints, "a"), read(ints, "b"), read(ints, "c"), read(ints, "a"), read(ints, "zz")]);
  const acc: any = { plain: 1 }; Object.defineProperty(acc, "get", { get(){ return "got" }, enumerable: true });
  show("accessor", [read(acc, "plain"), read(acc, "get"), read(acc, "plain"), read(acc, "get")]);
  const fr = Object.freeze({ x: 1, y: 2 }); show("frozen", [read(fr, "x"), read(fr, "y"), read(fr, "x")]);
  const np: any = Object.create(null); np.alpha = "A"; np.beta = "B";
  show("null proto", [read(np, "alpha"), read(np, "beta"), read(np, "gamma"), read(np, "alpha"), read(np, "toString")]);
  const arr: any = ["e0", "e1"]; arr.index = 7; arr.input = "in";
  show("array named", [read(arr, "index"), read(arr, "input"), read(arr, "length"), read(arr, "0"), read(arr, "1"), read(arr, "2"), read(arr, "index")]);
  const long = { "a-long-key-of-more-than-five": 1, "another-long-key-here": 2 };
  const k1 = "a-long-key-" + "of-more-than-five", k2 = "another-long" + "-key-here";
  show("heap keys", [read(long, k1), read(long, k2), read(long, k1), read(long, "a-long-key-of-more-than-fiv")]);
  const path = "/user/lookup/email"; const parts = path.split("/");
  const trie: any = { "": 0, user: 1, lookup: 2, email: 3 };
  show("slices", parts.map((p) => read(trie, p)).concat(parts.map((p) => read(trie, p.slice(0)))));
  const views = ["GETx".slice(0, 3), "POSTy".substring(0, 4), "xPUT".slice(1)];
  show("short slices", views.map((v) => read(routes, v)));
  const many: Record<string, number> = {}; for (let i = 0; i < 40; i++) many["k" + i] = i;
  let sum = 0; for (let rep = 0; rep < 5; rep++) for (let i = 0; i < 40; i++) sum += read(many, "k" + i) as number;
  show("megamorphic", [sum, read(many, "k39"), read(many, "k40")]);
  const sym = Symbol("s"); const withSym: any = { [sym]: "symval", s: "str" };
  show("symbol", [withSym[sym], read(withSym, "s"), withSym[sym]]);
  class Pt { x = 1; y = 2; constructor(public z: number){} }
  const pt: any = new Pt(3); pt.dyn = 4;
  show("class", [read(pt, "x"), read(pt, "y"), read(pt, "z"), read(pt, "dyn"), read(pt, "w"), read(pt, "x")]);
}
main();
