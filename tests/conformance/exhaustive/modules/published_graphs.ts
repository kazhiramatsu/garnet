// garnet:shared (docs/published_graphs_design.md): publish makes the graph
// immutable (plain objects, arrays, class instances with their typed fields,
// Maps and Sets), returns its argument, isPublished sees it, writes of every
// kind throw, reads still work, the rejected kinds throw before anything is
// frozen, and freezing is deep (a nested object, an array element).
import { publish, isPublished, sharesGraphs } from "garnet:shared";
class Leaf { v = 1; tag = "t"; bump(): void { this.v++; } }
function attempt(name: string, f: () => void): string {
  try { f(); return name + ":ok"; } catch (e) { return name + ":" + (e as Error).constructor.name + ":" + (e as Error).message; }
}
function main(): void {
  const out: string[] = [];
  const g = { n: 1, arr: [1, 2, { deep: true }] as (number | { deep: boolean })[], leaf: new Leaf(), m: new Map<string, number>([["k", 1]]), s: new Set<number>([1]), str: "s" };
  const r = publish(g);
  out.push("same:" + String(r === g), "published:" + [g, g.arr, g.arr[2], g.leaf, g.m, g.s, 42, "x", null].map(isPublished).join(","), "unpublished:" + String(isPublished({})), "frozen:" + String(Object.isFrozen(g)) + String(Object.isFrozen(g.arr)) + String(Object.isFrozen(g.leaf)));
  out.push(attempt("field", () => { g.n = 2; }));
  out.push(attempt("add", () => { (g as any).extra = 1; }));
  out.push(attempt("delete", () => { delete (g as any).n; }));
  out.push(attempt("elem", () => { g.arr[0] = 9; }));
  out.push(attempt("push", () => { g.arr.push(3); }));
  out.push(attempt("deep", () => { (g.arr[2] as { deep: boolean }).deep = false; }));
  out.push(attempt("typed", () => { g.leaf.v = 5; }));
  out.push(attempt("method", () => { g.leaf.bump(); }));
  out.push(attempt("map-set", () => { g.m.set("x", 1); }));
  out.push(attempt("map-delete", () => { g.m.delete("k"); }));
  out.push(attempt("map-clear", () => { g.m.clear(); }));
  out.push(attempt("set-add", () => { g.s.add(2); }));
  out.push(attempt("set-delete", () => { g.s.delete(1); }));
  out.push("reads:" + [g.n, g.arr.length, g.leaf.v, g.leaf.tag, g.m.get("k"), g.m.size, g.s.has(1), g.s.size, g.str].join(","));
  // the rejected kinds, and nothing frozen when a publish is rejected
  const h = { buf: new Uint8Array(2), x: 1 };
  out.push(attempt("typed-array", () => { publish(h); }), attempt("after-reject", () => { h.x = 2; }), "h.x=" + String(h.x), "h-published:" + String(isPublished(h)));
  out.push(attempt("arraybuffer", () => { publish({ b: new ArrayBuffer(4) }); }));
  out.push(attempt("weakmap", () => { publish([new WeakMap<object, number>()]); }));
  out.push(attempt("weakset", () => { publish({ w: new WeakSet<object>() }); }));
  // a shared structure: one object reached twice, a cycle
  const shared = { c: 0 };
  const cyc: { a: typeof shared; b: typeof shared; self?: unknown } = { a: shared, b: shared };
  cyc.self = cyc;
  publish(cyc);
  out.push(attempt("cycle", () => { shared.c = 1; }), "cycle-published:" + String(isPublished(cyc) && isPublished(shared)));
  // publishing again is a no-op; primitives publish to themselves
  out.push("again:" + String(publish(g) === g), "prim:" + String(publish(7)) + publish("p") + String(publish(null)), "shares:" + typeof sharesGraphs);
  console.log(out.join(" | "));
}
main();
