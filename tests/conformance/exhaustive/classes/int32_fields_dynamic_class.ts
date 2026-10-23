// Typed field slots (an enum-typed int32 slot, double slots) of a class that
// dispatches dynamically because its prototype was mutated: every field read
// and write goes through the runtime's property path and its inline cache,
// which must read an integer slot as an integer (it read it as a double:
// a denormal, and the parser of tsc-ts looped forever on it). Strict export
// gives the slots their kinds; the plain export keeps them boxed.
enum Kind { A = 1, B = 2, C = 3 }
class Tok {
  kind: Kind = Kind.A;
  pos: number = 0;
  depth: number = 7;
  ratio: number = 0.5;
  next(): void {
    this.kind = this.kind === Kind.C ? Kind.A : this.kind === Kind.A ? Kind.B : Kind.C;
    this.pos = this.pos + 1;
    this.ratio = this.ratio * 2;
  }
  describe(): string { return this.kind + ":" + this.pos + ":" + this.depth + ":" + this.ratio; }
}
// a typed prototype mutation: the class dispatches dynamically and reads its
// fields through the runtime, while the slots keep their kinds
Tok.prototype.describe = function (this: Tok): string { return "patched " + this.kind + " " + this.pos + " " + this.ratio; };
function main() {
  const t = new Tok(); t.next();
  const out: unknown[] = [t.kind, t.pos, t.depth, t.ratio, t.describe()];
  for (let i = 0; i < 4; i++) { out.push(t.kind, t.pos, t.ratio); t.next(); }
  const u = new Tok();
  for (let i = 0; i < 3; i++) { out.push(u.kind + u.pos + u.depth); u.next(); }
  out.push(u.describe(), JSON.stringify(u), Object.values(t).join(","));
  console.log(JSON.stringify(out));
} main();
