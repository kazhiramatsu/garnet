// In-object value slots: a plain object keeps its first properties inside its
// cell (literal sites size the inline area from the field list, function
// constructors learn an instance size, everything else gets a small default)
// and later properties overflow into the external vector. This fixture mixes
// literals that grow past their inline area, dictionary conversion through
// delete, constructor instances of varying size, frozen objects, spread
// copies, parsed JSON, accessors, prototype chains, and a tight allocation
// loop so moving collections copy inline areas.

function Pt(this: any, x: number, y: number) { this.x = x; this.y = y; }
function main() {
  const lits: any[] = [];
  for (let i = 0; i < 5; i++) { const o: any = { a: i, b: i * 2, c: "c" + i }; if (i > 2) { o.d = i; o.e = [i]; o.f = { g: i }; } lits.push(o); }
  console.log(JSON.stringify(lits));
  const big: any = {}; for (let i = 0; i < 20; i++) big["k" + i] = i; console.log(Object.keys(big).join(","), big.k0 + big.k19);
  delete big.k3; big.k3 = 33; console.log(Object.keys(big).length, big.k3, JSON.stringify(big).length);
  const pts: any[] = []; for (let i = 0; i < 6; i++) { const p: any = new (Pt as any)(i, i + 1); if (i === 2) { p.z = 9; p.w = 8; p.v = 7; } pts.push(p); }
  console.log(pts.map((p) => p.x + p.y + (p.z ?? 0)).join(","), Object.keys(pts[2]).join(","));
  const frozen = Object.freeze({ a: 1, b: 2 }); try { (frozen as any).a = 5; } catch (e) { console.log("frozen write threw"); } console.log(frozen.a);
  const spread = { ...lits[4], extra: true }; console.log(Object.keys(spread).join(","));
  const parsed = JSON.parse('{"p":1,"q":[1,2],"r":{"s":"t"}}'); parsed.u = 5; console.log(JSON.stringify(parsed));
  const withGetter = { get g() { return 42; }, h: 1 }; console.log(withGetter.g, withGetter.h, Object.keys(withGetter).join(","));
  const proto = { shared: 1 }; const child = Object.create(proto); child.own = 2; console.log(child.shared, child.own, Object.keys(child).join(","));
  let acc = 0; for (let i = 0; i < 100000; i++) { const t: any = { i, j: i + 1 }; acc += t.i + t.j; } console.log(acc);
  const many: any = { a1: 1, a2: 2, a3: 3, a4: 4, a5: 5, a6: 6, a7: 7, a8: 8, a9: 9, a10: 10 }; many.a11 = 11; console.log(Object.values(many).reduce((s: number, v: any) => s + v, 0), Object.keys(many).length);
}
main();
