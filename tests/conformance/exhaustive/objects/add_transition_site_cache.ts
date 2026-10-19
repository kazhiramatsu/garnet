// Per-site addition entries of the property store cache: a constructor's
// field-by-field initialization of fresh objects, the same site over two
// shapes, additions to old receivers under collection pressure, and every
// condition that must keep an entry from applying: a frozen or sealed
// receiver, a changed prototype, an accessor or a read-only property defined
// on the prototype after the entry was recorded, dictionary receivers,
// class instances with struct fields, growth past the in-object slots.
function Point(this: any, x: number, y: number) { this.x = x; this.y = y; }
function Link(this: any, target: any) { this.target = target; this.flags = 0; this.resolved = undefined; }
function makeWide(i: number): any {
  const o: any = {};
  o.a = i; o.b = i + 1; o.c = i + 2; o.d = i + 3; o.e = i + 4; o.f = i + 5; o.g = i + 6; o.h = i + 7; o.i = i + 8; o.j = i + 9; o.k = i + 10; o.l = i + 11;
  return o;
}
function setKind(o: any, k: number): void { o.kind = k; }
class Sized { constructor(public n: number) {} }
function main(): void {
  const pts: any[] = [];
  for (let i = 0; i < 1000; i++) pts.push(new (Point as any)(i, -i));
  let sum = 0;
  for (const p of pts) sum += p.x + p.y;
  console.log(sum, Object.keys(pts[0]).join(","), Object.keys(pts[999]).join(","));
  const wide = makeWide(5);
  console.log(Object.keys(wide).join(""), wide.l, makeWide(1).k, Object.keys(makeWide(2)).length);
  // one site, two shapes alternating
  const shapes: any[] = [];
  for (let i = 0; i < 200; i++) { const o: any = i % 2 ? { a: 1 } : { b: 2, c: 3 }; setKind(o, i); shapes.push(o); }
  console.log(shapes[10].kind, shapes[11].kind, Object.keys(shapes[10]).join(","), Object.keys(shapes[11]).join(","));
  // frozen and sealed receivers at a site that cached the addition
  const f: any = {}; const g: any = {}; const s: any = {};
  setKind(f, 1); Object.freeze(g); Object.seal(s);
  try { setKind(g, 2); console.log("no throw"); } catch (e: any) { console.log("frozen", e instanceof TypeError); }
  try { setKind(s, 3); console.log("no throw"); } catch (e: any) { console.log("sealed", e instanceof TypeError); }
  console.log(f.kind, g.kind, s.kind, Object.isFrozen(g));
  // an accessor defined on the prototype after the entry was recorded
  const proto: any = {};
  const a1: any = Object.create(proto); setKind(a1, 10);
  let setterSeen = 0;
  Object.defineProperty(proto, "kind", { set(v: number) { setterSeen = v; }, get() { return 99; }, configurable: true });
  const a2: any = Object.create(proto); setKind(a2, 20);
  console.log(a1.kind, a2.kind, setterSeen, Object.keys(a2).length, Object.keys(a1).length);
  // a read-only data property on the prototype after the entry was recorded
  const proto2: any = {};
  const b1: any = Object.create(proto2); setKind(b1, 30);
  Object.defineProperty(proto2, "kind", { value: 7, writable: false, configurable: true });
  const b2: any = Object.create(proto2);
  try { setKind(b2, 40); console.log("no throw", b2.kind, Object.keys(b2).length); } catch (e: any) { console.log("readonly", e instanceof TypeError, b2.kind); }
  // a changed prototype at the same site
  const proto3: any = { tag: "p3" };
  const c1: any = {}; setKind(c1, 50);
  const c2: any = {}; Object.setPrototypeOf(c2, proto3); setKind(c2, 60);
  console.log(c1.kind, c2.kind, c2.tag, Object.getPrototypeOf(c2) === proto3);
  // dictionary receivers (after a delete) and class instances with struct fields
  const d: any = { a: 1, b: 2 }; delete d.a; setKind(d, 70);
  const z: any = new Sized(3); setKind(z, 80);
  console.log(d.kind, Object.keys(d).join(","), z.kind, z.n, Object.keys(z).join(","));
  // symbol keys and a key that already exists
  const sym = Symbol("k");
  const e1: any = {}; e1[sym] = 1; e1.kind = 1; setKind(e1, 90);
  console.log(e1.kind, e1[sym], Object.keys(e1).join(","));
  // old receivers gaining young values across collections (barrier precision)
  const links: any[] = [];
  for (let i = 0; i < 5000; i++) links.push(new (Link as any)(null));
  for (let round = 0; round < 6; round++) {
    let junk: any = null;
    for (let i = 0; i < 30000; i++) junk = { i, junk: i % 3 ? null : junk };
    for (let i = round; i < links.length; i += 6) { links[i].resolved = { id: i, round }; links[i].extra = { r: round }; }
    if (junk === undefined) console.log("never");
  }
  let ok = 0, missing = 0;
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (l.resolved && l.resolved.id === i && l.extra && l.extra.r === i % 6) ok++; else missing++;
  }
  console.log(ok, missing, Object.keys(links[7]).join(","));
}
main();
