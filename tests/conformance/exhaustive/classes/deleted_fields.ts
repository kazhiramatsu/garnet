// `delete` of a class field removes the own property, as V8 does
// (docs/closed_receivers_design.md, slice 2): the instance becomes a plain
// object behind the same prototype, so `in`, Object.keys, JSON, a typed read
// through the class and the class's own methods all see the field gone; a
// re-added field goes to the end of the key order; other fields, own
// properties added earlier and methods keep working; a frozen or sealed
// instance refuses (false in a property access, TypeError in strict code).
class P {
  x: number | undefined;
  y: string | undefined;
  z: boolean;
  constructor(x: number, y: string) { this.x = x; this.y = y; this.z = true; }
  describe(): string { return `${String(this.x)}/${String(this.y)}/${String(this.z)}`; }
}
class Q extends P {
  w = "w";
  tag(): string { return this.w + this.describe(); }
}
function readY(p: P): string | undefined { return p.y; }
function main(): void {
  const p = new P(1, "a");
  (p as unknown as Record<string, unknown>).extra = 42;
  console.log(delete p.y, "y" in p, Object.keys(p).join(","), JSON.stringify(p), String(readY(p)), p.describe());
  p.y = "again";
  console.log(Object.keys(p).join(","), readY(p), p.describe(), p instanceof P);
  const q = new Q(2, "b");
  delete (q as unknown as Record<string, unknown>).x;
  console.log(q.tag(), Object.keys(q).join(","), String(q.x), q.w, q instanceof Q);
  q.x = 9;
  console.log(q.describe(), Object.keys(q).join(","));
  const f = new P(3, "c");
  Object.freeze(f);
  try { console.log(delete (f as unknown as Record<string, unknown>).x, f.x); } catch (e) { console.log((e as Error).constructor.name, f.x); }
  const s = new P(4, "d");
  Object.seal(s);
  try { delete (s as unknown as Record<string, unknown>).y; console.log("deleted?", s.y); } catch (e) { console.log((e as Error).constructor.name, s.y); }
  const many: P[] = [];
  for (let i = 0; i < 5; i++) { const o = new P(i, "n" + i); if (i % 2) delete o.x; many.push(o); }
  console.log(many.map((o) => o.describe()).join(" "), many.map((o) => Object.keys(o).length).join(""));
}
main();
