// A scalar-replaceable instance created inside a block and kept in a local
// declared outside it: the object must stay materialized (the rewrite keeps
// aliases per block). Loops, branches, try bodies, copies and direct
// assignments, two outer locals from one site, closures created in a loop.
class C { constructor(public i: number, public s: string = "c") {} double(): number { return this.i * 2; } }
function viaCopy(): string { let a: C | undefined; for (const i of [1, 2]) { const o = new C(i); a = o; } return a!.i + ":" + a!.double(); }
function viaAssign(): string { let a: C | undefined; for (let i = 1; i <= 2; i++) { a = new C(i, "x" + i); } return a ? a.s + a.i : "none"; }
function twoLocals(): string { let a: C | undefined; let b: C | undefined; for (const i of [1, 2]) { const o = new C(i); if (i === 1) a = o; else b = o; } return a!.i + "," + b!.i + "," + (a === b); }
function fromBranch(flag: boolean): number { let a: C | undefined; if (flag) { a = new C(9); } return a ? a.i : -1; }
function fromTry(): number { let a: C | undefined; try { const o = new C(5); a = o; } finally { a = a ?? new C(6); } return a.double(); }
function closuresInLoop(): string { let f1: (() => number) | undefined; let f2: (() => number) | undefined; for (const i of [1, 2]) { const f = () => i * 10; if (i === 1) f1 = f; else f2 = f; } return f1!() + "/" + f2!(); }
function innerOnly(): number { let s = 0; for (let k = 0; k < 3; k++) { const o = new C(k); s += o.double(); } return s; }
function nestedUse(): number { const o = new C(4); let s = 0; for (let k = 0; k < 3; k++) { if (k > 0) { const p = o; s += p.i; } } return s + o.i; }
function whileLoop(): number { let a: C | undefined; let n = 0; while (n < 3) { a = new C(n); n++; } return a!.i; }
function main(): void {
  console.log(viaCopy(), viaAssign(), twoLocals(), fromBranch(true), fromBranch(false), fromTry(), closuresInLoop(), innerOnly(), nestedUse(), whileLoop());
}
main();
