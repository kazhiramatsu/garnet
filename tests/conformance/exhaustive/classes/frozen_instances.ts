// Object.freeze on class instances: a typed direct store to a declared field
// throws as strict JS does (number, string, boolean, int32-like and object
// fields; a subclass's inherited field; a store through `any`), while sealed
// and non-extensible instances keep their declared fields writable, adding a
// property to them throws, methods still run, and the values are unchanged.
class Vec { x = 1; y = 2.5; label = "v"; on = true; next: Vec | null = null; len(): number { return this.x + this.y; } }
class Vec3 extends Vec { z = 3; sum(): number { return this.x + this.y + this.z; } }
function attempt(name: string, f: () => void): string {
  try { f(); return name + ":ok"; } catch (e) { return name + ":" + (e as Error).constructor.name + ":" + (e as Error).message; }
}
function viaAny(q: any, n: number): void { q.x = n; }
function main(): void {
  const out: string[] = [];
  const v = new Vec();
  v.x = 10; v.label = "ten";           // writes before the freeze
  Object.freeze(v);
  out.push(attempt("num", () => { v.x = 11; }));
  out.push(attempt("str", () => { v.label = "eleven"; }));
  out.push(attempt("bool", () => { v.on = false; }));
  out.push(attempt("dbl", () => { v.y = 0.5; }));
  out.push(attempt("obj", () => { v.next = new Vec(); }));
  out.push(attempt("any", () => { viaAny(v, 12); }));
  out.push(attempt("add", () => { (v as any).extra = 1; }));
  out.push("values", String(v.x), v.label, String(v.on), String(v.y), String(v.next), String(v.len()), String(Object.isFrozen(v)));
  // a subclass instance: the base class's field and its own
  const w = new Vec3();
  Object.freeze(w);
  out.push(attempt("sub-base", () => { w.x = 5; }), attempt("sub-own", () => { w.z = 6; }), String(w.sum()));
  // sealed and non-extensible: declared fields stay writable, additions throw
  const s = new Vec(); Object.seal(s);
  out.push(attempt("sealed-write", () => { s.x = 7; }), attempt("sealed-add", () => { (s as any).more = 1; }), String(s.x), String(Object.isSealed(s)));
  const n = new Vec(); Object.preventExtensions(n);
  out.push(attempt("nonext-write", () => { n.label = "n"; }), attempt("nonext-add", () => { (n as any).more = 1; }), n.label, String(Object.isExtensible(n)));
  // a hot loop over mixed instances: the frozen one throws every time
  const items: Vec[] = [new Vec(), Object.freeze(new Vec()) as Vec, new Vec()];
  let ok = 0, thrown = 0;
  for (let i = 0; i < 300; i++) {
    const it = items[i % 3];
    try { it.x = i; ok++; } catch (e) { thrown++; }
  }
  out.push("loop", String(ok), String(thrown), String(items[0].x), String(items[1].x), String(items[2].x));
  console.log(out.join(" "));
}
main();
