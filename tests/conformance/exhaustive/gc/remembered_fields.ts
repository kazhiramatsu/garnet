// Young values stored into the fields of old class instances: the first
// field, a middle one, the 31st, the 32nd and beyond (the mask's last bit),
// a subclass's own field, a field written through `any` (the dynamic store),
// a dynamic property added to an instance (its sidecar), a prototype write
// and a stored method; collections run between the writes and the reads (the
// harness also runs this with every collection setting forced).
class Wide {
  f0: unknown = undefined; f1: unknown = undefined; f2: unknown = undefined; f3: unknown = undefined; f4: unknown = undefined;
  f5: unknown = undefined; f6: unknown = undefined; f7: unknown = undefined; f8: unknown = undefined; f9: unknown = undefined;
  f10: unknown = undefined; f11: unknown = undefined; f12: unknown = undefined; f13: unknown = undefined; f14: unknown = undefined;
  f15: unknown = undefined; f16: unknown = undefined; f17: unknown = undefined; f18: unknown = undefined; f19: unknown = undefined;
  f20: unknown = undefined; f21: unknown = undefined; f22: unknown = undefined; f23: unknown = undefined; f24: unknown = undefined;
  f25: unknown = undefined; f26: unknown = undefined; f27: unknown = undefined; f28: unknown = undefined; f29: unknown = undefined;
  f30: unknown = undefined; f31: unknown = undefined; f32: unknown = undefined; f33: unknown = undefined; f34: unknown = undefined;
  n0 = 0; n1 = 0;
  constructor(public id: number) {}
}
class Wider extends Wide { extra: unknown = undefined; last: unknown = undefined; }
interface Bag { [k: string]: unknown }
function churn(n: number): number { let s = 0; for (let i = 0; i < n; i++) { const t = { a: i, b: [i] }; s = (s + t.a + t.b.length) % 1000; } return s; }
function tag(round: number, i: number, k: string): { r: number; i: number; k: string } { return { r: round, i, k }; }
function main(): void {
  const olds: Wide[] = [];
  for (let i = 0; i < 60; i++) olds.push(i % 2 === 0 ? new Wide(i) : new Wider(i));
  const protoHolder = new Wide(1000);
  let s = churn(300000);                                                   // the instances above age into the old generation
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < olds.length; i++) {
      const o = olds[i];
      o.f0 = tag(round, i, "f0");                                            // bit 0
      o.f17 = [round, i];                                                    // a middle bit
      if (i % 3 === 0) o.f30 = tag(round, i, "f30");                         // the 31st field
      if (i % 3 === 1) o.f31 = tag(round, i, "f31");                         // the 32nd: the last bit
      if (i % 3 === 2) o.f34 = tag(round, i, "f34");                         // beyond
      o.n0 = round; o.n1 = i;                                                // numeric fields: no barrier
      if (o instanceof Wider) { o.extra = tag(round, i, "extra"); o.last = [round]; }
      if (i % 5 === 0) (o as unknown as Bag)["f9"] = tag(round, i, "dyn");   // the dynamic store into a field
      if (i % 7 === 0) (o as unknown as Bag)["side" + round] = { side: round }; // a sidecar property
    }
    (Wide.prototype as unknown as Bag)["shared" + round] = { shared: round };
    (protoHolder as unknown as Bag)["m"] = () => round;
    s = (s + churn(200000)) % 1000;                                         // collections: the young values must survive
    for (let i = 0; i < olds.length; i++) {
      const o = olds[i];
      const a = o.f0 as { r: number; i: number; k: string }; if (a.r !== round || a.i !== i || a.k !== "f0") throw new Error("f0 " + round + " " + i);
      const b = o.f17 as number[]; if (b[0] !== round || b[1] !== i) throw new Error("f17");
      if (i % 3 === 0 && (o.f30 as { r: number }).r !== round) throw new Error("f30");
      if (i % 3 === 1 && (o.f31 as { r: number }).r !== round) throw new Error("f31");
      if (i % 3 === 2 && (o.f34 as { r: number }).r !== round) throw new Error("f34");
      if (o.n0 !== round || o.n1 !== i) throw new Error("numeric");
      if (o instanceof Wider && ((o.extra as { k: string }).k !== "extra" || (o.last as number[])[0] !== round)) throw new Error("wider");
      if (i % 5 === 0 && (o.f9 as { k: string }).k !== "dyn") throw new Error("dyn");
      if (i % 7 === 0 && ((o as unknown as Bag)["side" + round] as { side: number }).side !== round) throw new Error("side");
      if (((o as unknown as Bag)["shared" + round] as { shared: number }).shared !== round) throw new Error("shared");
    }
    if (((protoHolder as unknown as Bag)["m"] as () => number)() !== round) throw new Error("method");
  }
  console.log("ok", s, olds.length);
}
main();
