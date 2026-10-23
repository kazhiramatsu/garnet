// One access site over many classes (megamorphic): twenty-four node classes
// read and written through `any` at the same sites, in an order that evicts
// every cache entry repeatedly, with boxed, double and enum-typed slots, a
// frozen instance among them (TypeError on write), a plain object and an
// instance with own dynamic properties in the mix; the typed reads agree.
enum K { A = 1, B = 2, C = 3, D = 4 }
class N0 { kind: K = K.A; pos: number = 0; tag: string = "n0"; }
class N1 extends N0 { tag = "n1"; extra1: number = 1; }
class N2 extends N0 { tag = "n2"; }
class N3 extends N1 { tag = "n3"; }
class N4 extends N0 { tag = "n4"; w: number = 4.5; }
class N5 extends N4 { tag = "n5"; }
class N6 extends N0 { tag = "n6"; }
class N7 extends N2 { tag = "n7"; }
class N8 extends N0 { tag = "n8"; }
class N9 extends N8 { tag = "n9"; }
class N10 extends N0 { tag = "n10"; }
class N11 extends N0 { tag = "n11"; }
class N12 extends N6 { tag = "n12"; }
class N13 extends N0 { tag = "n13"; }
class N14 extends N13 { tag = "n14"; }
class N15 extends N0 { tag = "n15"; }
class N16 extends N0 { tag = "n16"; }
class N17 extends N3 { tag = "n17"; }
class N18 extends N0 { tag = "n18"; }
class N19 extends N0 { tag = "n19"; }
class N20 extends N10 { tag = "n20"; }
class N21 extends N0 { tag = "n21"; }
class N22 extends N0 { tag = "n22"; }
class N23 extends N0 { tag = "n23"; }
N0.prototype.toString = function (this: N0): string { return this.tag + ":" + this.kind + ":" + this.pos; };
function read(x: any): string { return x.tag + "/" + x.kind + "/" + x.pos; }
function write(x: any, i: number): void { x.pos = x.pos + i; x.kind = x.kind === K.D ? K.A : x.kind + 1; }
function main() {
  const out: unknown[] = [];
  const nodes: any[] = [new N0(), new N1(), new N2(), new N3(), new N4(), new N5(), new N6(), new N7(), new N8(), new N9(), new N10(), new N11(),
    new N12(), new N13(), new N14(), new N15(), new N16(), new N17(), new N18(), new N19(), new N20(), new N21(), new N22(), new N23()];
  const frozen = Object.freeze(new N7()) as any;
  const dyn = new N9() as any; dyn.added = "yes";
  const plain = { tag: "plain", kind: 9, pos: -5 };
  const all = nodes.concat([frozen, dyn, plain]);
  let acc = "";
  for (let round = 0; round < 6; round++) {
    for (const x of all) {
      acc += read(x) + ";";
      try { write(x, round); } catch (e) { acc += (e as Error).constructor.name + ";"; }
    }
  }
  out.push(acc.length, acc.slice(0, 120), acc.slice(-120));
  out.push(nodes.map((n) => String(n)).join(","), dyn.added, dyn.pos, plain.pos, frozen.pos);
  const typed: N0[] = nodes;
  out.push(typed.map((n) => n.kind + n.pos).join(","), (nodes[4] as N4).w, (nodes[1] as N1).extra1);
  console.log(JSON.stringify(out));
}
main();
