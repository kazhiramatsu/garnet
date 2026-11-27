// The sign of zero through integer slots (docs/unmasked_pointers_design.md, section 4): an integer slot
// holds +0 and refuses -0 (the slot gives way to a boxed one), which the runtime tells by the sign bit of
// the number's word, the bit representation 1 inverts. Both zeros stored into a literal's integer slots,
// typed and through `any`, read back typed and dynamically and told apart by Object.is; a class's
// integer field takes +0.
interface Rec { flags: number; tag: number; label: string }
function mk(i: number): Rec {
  const f = i & 7, t = (i >> 1) & 3;
  return { flags: f, tag: t, label: "r" + i };
}
function dyn(o: any, k: string): any { return o[k]; }
function sign(x: number): string { return Object.is(x, -0) ? "-0" : Object.is(x, 0) ? "+0" : String(x); }
function negZero(n: number): number { return n * -0; }
class Counter {
  pos = 0;
  bump(): void { this.pos = (this.pos + 1) | 0; }
  reset(): void { this.pos = 0; }
}
function main(): void {
  const rs: Rec[] = [];
  for (let i = 0; i < 6; i++) rs.push(mk(i + 1));
  rs[0].flags = 0;
  rs[1].flags = negZero(3);
  (rs[2] as any).flags = -0;
  (rs[3] as any).flags = 0;
  rs[4].tag = negZero(1) | 0;
  rs[5].tag = negZero(2);
  for (const r of rs) console.log(sign(r.flags), sign(dyn(r, "flags")), r.flags & 3, sign(r.tag), sign(dyn(r, "tag")), r.tag | 0);
  console.log(JSON.stringify(rs[1]), JSON.stringify(rs[2]), Object.keys(rs[2]).join(","), Object.values(rs[5]).map((v) => typeof v).join(","));
  let acc = 0;
  for (const r of rs) acc = (acc + (r.flags | 0) + (r.tag & 3)) | 0;
  console.log(acc);
  const c = new Counter();
  c.bump(); c.bump(); c.reset();
  console.log(sign(c.pos), c.pos | 0);
  c.bump();
  console.log(sign(c.pos), sign(dyn(c, "pos")));
}
main();
