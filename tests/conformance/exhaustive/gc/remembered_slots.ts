// Young values stored into old objects at low, middle, high and beyond-range
// slots, into dictionary objects, after deletion, through prototypes and into
// class instances; collections happen between the writes and the reads (the
// harness also runs this with every collection setting forced).
class Box { constructor(public v: number) {} }
interface Wide { [k: string]: unknown }
function churn(n: number): number { let s = 0; for (let i = 0; i < n; i++) { const t = { a: i, b: [i] }; s = (s + t.a + t.b.length) % 1000; } return s; }
function makeWide(count: number): Wide { const o: Wide = {}; for (let i = 0; i < count; i++) o["k" + i] = i; return o; }
function main(): void {
  const olds: Wide[] = [];
  for (let i = 0; i < 40; i++) olds.push(makeWide(10 + (i % 3) * 60));   // 10, 70, 130 properties
  const cls = new Box(1);
  const proto: Wide = makeWide(5);
  const child: Wide = Object.create(proto) as Wide;
  const dict: Wide = makeWide(140);
  let s = churn(300000);                                                   // the objects above age into the old generation
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < olds.length; i++) {
      const o = olds[i];
      o["k0"] = { r: round, i };                                            // card 0
      o["k9"] = [round, i];                                                 // card 1
      if (i % 3 === 1) o["k69"] = { tail: round };                          // card 8
      if (i % 3 === 2) o["k129"] = { far: round };                          // beyond the covered range
      o["fresh" + round] = { added: round };                                // appended property
    }
    (cls as unknown as Wide)["dyn"] = { d: round };
    cls.v = round;
    proto["k2"] = { p: round };
    child["own"] = { c: round };
    dict["k77"] = { m: round };
    delete dict["k3"];
    dict["k3"] = { back: round };
    s += churn(200000);                                                     // minor collections move the young values
    let check = 0;
    for (let i = 0; i < olds.length; i++) {
      const o = olds[i];
      check += (o["k0"] as { r: number; i: number }).r + (o["k9"] as number[])[1];
      if (i % 3 === 1) check += (o["k69"] as { tail: number }).tail;
      if (i % 3 === 2) check += (o["k129"] as { far: number }).far;
      check += (o["fresh" + round] as { added: number }).added;
    }
    check += ((cls as unknown as Wide)["dyn"] as { d: number }).d + cls.v + (proto["k2"] as { p: number }).p + (child["own"] as { c: number }).c + (child["k2"] as { p: number }).p;
    check += (dict["k77"] as { m: number }).m + (dict["k3"] as { back: number }).back;
    console.log(round, check, Object.keys(olds[1]).length, Object.keys(dict).length);
  }
  console.log(s % 7);
}
main();
