// @ts-nocheck
// a class evaluated twice: a prototype per evaluation, the method caches keyed by the class word hold the first
function makeBox(seed: number, key: string) {
  class Local {
    base = seed;
    constructor(extra: number) { this.base = seed + extra; }
    [key](n: number): number { return this.base * n + seed; }
  }
  return new Local(1);
}
const lb: any = makeBox(10, "scaled");
console.log(lb.scaled(2));
const lb2: any = makeBox(100, "scaled");
console.log(lb2.base, lb2.scaled(1), lb.scaled(1));
const p1 = Object.getPrototypeOf(lb), p2 = Object.getPrototypeOf(lb2);
console.log(p1 === p2, p1.scaled === p2.scaled, lb.constructor === lb2.constructor);
function viaProto(v) { class A { m() { return "orig"; } } A.prototype.m = function () { return v; }; return new A(); }
const a1: any = viaProto(1), a2: any = viaProto(2);
for (let i = 0; i < 3; i++) console.log(a1.m(), a2.m());
