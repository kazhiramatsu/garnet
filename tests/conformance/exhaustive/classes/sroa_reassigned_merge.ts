// SROA must not scalar-replace an allocation whose local (or a copy alias of
// it) has another definition: the alias maps are flow-insensitive, so a read
// after the join (if / switch / catch / loop / a closure's assignment / a
// reassigned parameter) was rewritten to one allocation's fields whichever
// path ran, or read the never-assigned local of the scalarized allocation.
class B { v: number; w = 2; constructor(v: number) { this.v = v; } }
function ifJoin(i: number): number { let b = new B(i); if (i < 0) b = new B(0); return b.v; }
function ifElse(i: number): number { let b = new B(i); if (i > 100) { b = new B(0); } else { b.w = 7; } return b.v + b.w; }
function viaAlias(i: number): number { const b0 = new B(i); let b = b0; if (i < 0) b = new B(0); return b.v; }
function captured(i: number): number { let b = new B(i); if (i < 0) b = new B(0); const f = () => b.v; return f(); }
function callback(i: number): number { let b = new B(i); if (i < 0) b = new B(0); return [1, 2].map(x => x + b.v)[1]; }
function inArray(i: number): number { let b = new B(i); if (i < 0) { b = new B(0); } const arr = [b]; return arr[0].v; }
function loopJoin(i: number): number { let b = new B(i); for (let k = 0; k < 2; k++) { if (k === i) b = new B(k * 10); } return b.v; }
function doJoin(i: number): number { let b = new B(i); let k = 0; do { if (k === 1 && i < 0) b = new B(-k); k++; } while (k < 3); return b.v; }
function catchJoin(i: number): number { let b = new B(i); try { if (i < 0) throw 1; } catch (e) { b = new B(0); } return b.v; }
function switchJoin(i: number): number { let b = new B(i); switch (i) { case 1: b = new B(10); break; case 2: b = new B(20); break; } return b.v; }
function setter(i: number): number { let b = new B(i); const set = () => { b = new B(99); }; if (i < 0) set(); return b.v; }
function param(p: B, i: number): number { const x = p.v; p = new B(i * 5); return x + p.v; }
function ternary(i: number): number { const b = i < 0 ? new B(0) : new B(i); return b.v; }
function main(): void {
  for (const i of [-1, 0, 1, 2, 3]) {
    console.log(ifJoin(i), ifElse(i), viaAlias(i), captured(i), callback(i), inArray(i), loopJoin(i),
      doJoin(i), catchJoin(i), switchJoin(i), setter(i), param(new B(1), i), ternary(i));
  }
}
main();
