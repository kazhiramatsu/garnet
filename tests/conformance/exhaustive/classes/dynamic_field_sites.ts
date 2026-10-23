// Field reads and writes of class instances through dynamic sites (`any`
// receivers, a prototype-mutated class): monomorphic and polymorphic sites
// over several classes with boxed, double and enum-typed slots, writes of
// every kind, an instance with own dynamic properties, an instance whose
// prototype was relinked, a frozen instance (TypeError on write), a sealed
// one, a plain object and a null at the same sites, and the values read
// back through the typed paths afterwards.
enum Kind { A = 1, B = 2, C = 3 }
class AstNode { kind: Kind = Kind.A; pos: number = 0; name: string = "n"; child: AstNode | null = null; }
class Leaf extends AstNode { value: number = 1.5; }
class Pair extends AstNode { left: AstNode | null = null; right: AstNode | null = null; weight: number = 2; }
class Other { kind: Kind = Kind.C; pos: number = 100; label: string = "other"; }
// the classes dispatch dynamically
AstNode.prototype.toString = function (this: AstNode): string { return "AstNode:" + this.kind + ":" + this.pos; };
function readAll(x: any): string { return x.kind + "/" + x.pos + "/" + x.name + "/" + (x.child === null ? "-" : "c"); }
function bump(x: any, by: number): void { x.pos = x.pos + by; x.kind = x.kind === Kind.C ? Kind.A : x.kind + 1; x.name = x.name + "!"; }
function main() {
  const out: unknown[] = [];
  const n = new AstNode(), l = new Leaf(), p = new Pair(), o = new Other();
  const items: any[] = [n, l, p, o, n, l, p, o, { kind: 9, pos: -1, name: "plain", child: null }];
  for (let round = 0; round < 3; round++) for (const it of items) { out.push(readAll(it)); bump(it, round + 1); }
  l.value = 2.25; (l as any).value = (l as any).value * 2; p.left = l; (p as any).right = o;
  out.push((l as any).value, (p as any).left === l, (p as any).right === o, (p as any).weight, String(n), String(l));
  // an instance with own dynamic properties and one relinked
  const d = new Leaf() as any; d.extra = 7; d.pos = 50; out.push(d.pos, d.extra, readAll(d));
  const r = new Leaf(); Object.setPrototypeOf(r, Other.prototype); const ra = r as any; ra.pos = 77; out.push(ra.pos, ra.kind, ra.label, readAll(ra));
  // frozen and sealed instances
  const f = Object.freeze(new AstNode()) as any; let threw = ""; try { f.pos = 1; } catch (e) { threw = (e as Error).constructor.name; } out.push(threw, f.pos);
  const s = Object.seal(new AstNode()) as any; s.pos = 5; let threw2 = ""; try { s.added = 1; } catch (e) { threw2 = (e as Error).constructor.name; } out.push(s.pos, threw2);
  // null and undefined at the same sites
  let threw3 = ""; try { readAll(null); } catch (e) { threw3 = (e as Error).constructor.name; } out.push(threw3);
  let threw4 = ""; try { bump(undefined, 1); } catch (e) { threw4 = (e as Error).constructor.name; } out.push(threw4);
  // typed reads afterwards
  out.push(n.kind, n.pos, n.name, l.kind, l.pos, p.kind, p.pos, o.kind, o.pos, o.label, l.value, p.weight);
  console.log(JSON.stringify(out));
}
main();
