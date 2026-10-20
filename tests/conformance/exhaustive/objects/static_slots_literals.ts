// Object literals as producer layouts of the static slots
// (docs/static_slots_design.md, literal producers): interface-typed reads and
// writes hinted from literals built in source order, then receivers the hint
// does not fit: the same interface built in another key order, with a method,
// with a getter or a setter on a hinted key, frozen (the write throws), after
// a delete (dictionary), a literal extended by later stores, literals returned
// by a factory, a spread or a computed key (no layout), and a union receiver.
interface Flow { flags: number; id: number; node?: string; antecedent?: Flow; }
interface Pt { x: number; y: number; tag: string; }
function createFlow(flags: number, node: string | undefined, antecedent: Flow | undefined): Flow {
  return { flags, id: 0, node, antecedent };
}
function readFlow(f: Flow): number { return f.flags * 10 + f.id + (f.node ? f.node.length : 0) + (f.antecedent ? f.antecedent.flags : 0); }
function bump(f: Flow): void { f.id = f.id + 1; f.flags |= 8; }
function sumPt(p: Pt): string { return `${p.x + p.y}:${p.tag}`; }
function main(): void {
  const flows: Flow[] = [];
  for (let i = 0; i < 50; i++) flows.push(createFlow(i, (i & 1) ? "n" + i : undefined, i ? flows[i - 1] : undefined));
  const other: Flow = { id: 7, flags: 3, antecedent: flows[2] };             // another key order
  const extended: Flow = { flags: 5, id: 1 }; extended.node = "ext"; extended.antecedent = other;
  let getterCalls = 0;
  const withGetter: Flow = { get flags() { getterCalls++; return 4; }, id: 2 } as Flow;
  const withSetter = { flags: 1, id: 0, set node(v: string) { (this as any)._n = v + "!"; } } as Flow;
  const frozen: Flow = Object.freeze({ flags: 9, id: 9 });
  const deleted: Flow = { flags: 6, id: 6, node: "d" }; delete deleted.node;
  const spread: Flow = { ...flows[3], id: 33 };
  const k = "flags";
  const computed: Flow = { [k]: 12, id: 4 } as Flow;
  const all = [...flows.slice(0, 5), other, extended, withGetter, withSetter, frozen, deleted, spread, computed];
  let s = 0;
  for (const f of all) s += readFlow(f);
  for (const f of all) { try { bump(f); } catch (e) { s += 1000; } }
  withSetter.node = "w";
  const pts: Pt[] = [{ x: 1, y: 2, tag: "a" }, { tag: "b", y: 4, x: 3 }, { x: 5, y: 6, tag: "c", ...{ z: 1 } } as Pt];
  const u: Flow | Pt = (s & 1) ? pts[0] : flows[4];
  console.log(s, getterCalls, all.map((f) => f.flags + "/" + f.id).join(" "), (withSetter as any)._n, frozen.id,
    Object.keys(deleted).join(","), Object.keys(spread).join(","), pts.map(sumPt).join(" "), "flags" in u ? u.flags : u.x);
}
main();
