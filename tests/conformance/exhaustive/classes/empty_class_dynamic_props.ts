// Field-less classes (a brand-only class expression, an empty declaration, an
// empty subclass) whose instances receive their properties lazily: key order,
// JSON, enumeration, instanceof, methods and accessors on the prototype,
// deletion, freezing, dynamic `new` through a function value, many instances.
interface Links { _brand?: any; type?: number; target?: Links; name?: string; count?: number; }
const Links = class implements Links { declare _brand: any; };
class Empty {}
class Sub extends Empty { tag = 1; }
class EmptySub extends Empty {}
class WithProto { describe(): string { return Object.keys(this).join("+"); } get size(): number { return Object.keys(this).length; } }
interface WithProto { a?: number; b?: string; }
function main(): void {
  const table: (Links | undefined)[] = [];
  const get = (i: number): Links => table[i] ??= new Links();
  for (let i = 0; i < 300; i++) table.push(undefined);
  for (let i = 0; i < 300; i++) {
    const l = get(i);
    if (i % 3 === 0) { l.type = i; l.name = "n" + i; } else { l.name = "m" + i; l.type = -i; }
    if (i % 5 === 0) l.target = get((i + 7) % 300);
    if (i % 7 === 0) l.count = (l.count ?? 0) + 1;
  }
  let sum = 0, targets = 0, counted = 0;
  for (let i = 0; i < 300; i++) {
    const l = get(i); sum += l.type!;
    if (l.target !== undefined) { targets++; sum += l.target.type!; }
    if (l.count !== undefined) counted += l.count;
  }
  console.log(sum, targets, counted, Object.keys(get(0)).join(","), Object.keys(get(1)).join(","), JSON.stringify(get(5)));
  console.log(get(0) instanceof Links, get(0).constructor === Links, Object.getPrototypeOf(get(0)) === Links.prototype, "type" in get(0), get(0).hasOwnProperty("name"), get(2).hasOwnProperty("target"));
  // deletion and re-addition
  const d = get(3); delete d.name; d.name = "again"; console.log(Object.keys(d).join(","), d.name);
  // freezing a populated instance (strict mode: the write throws)
  const f = get(4); Object.freeze(f);
  try { f.type = 99; console.log("no throw"); } catch (e) { console.log("frozen", f.type, Object.isFrozen(f)); }
  // empty class declaration: static and dynamic `new`
  const e1 = new Empty(); const K = Empty as unknown as new () => Empty; const e2 = new K();
  (e1 as any).x = 1; (e1 as any).y = 2; (e2 as any).y = 2; (e2 as any).x = 1;
  console.log(Object.keys(e1).join(","), Object.keys(e2).join(","), e1 instanceof Empty, e2 instanceof Empty, (e1 as any).x + (e2 as any).y);
  const s1 = new Sub(); (s1 as any).extra = "e"; console.log(Object.keys(s1).join(","), s1 instanceof Empty, s1 instanceof Sub, s1.tag);
  const s2 = new EmptySub(); (s2 as any).later = true; console.log(Object.keys(s2).join(","), s2 instanceof Empty, s2 instanceof EmptySub);
  // prototype methods and accessors see the dynamic properties
  const w = new WithProto(); w.a = 1; w.b = "b"; console.log(w.describe(), w.size, JSON.stringify(w));
  // many instances with collections in between
  const many: Links[] = [];
  for (let i = 0; i < 20000; i++) {
    const l: Links = new Links(); l.type = i;
    if (i & 1) l.name = "x" + (i & 1023);
    if ((i & 15) === 0 && i > 0) l.target = many[i >> 1];
    many.push(l);
  }
  let acc = 0, named = 0;
  for (const l of many) {
    acc += l.type!;
    if (l.name !== undefined) named++;
    if (l.target !== undefined && l.target.type! >= l.type!) acc = -1;
  }
  console.log(acc, named, many[16].target === many[8], Object.keys(many[17]).join(","), Object.keys(many[32]).join(","));
}
main();
