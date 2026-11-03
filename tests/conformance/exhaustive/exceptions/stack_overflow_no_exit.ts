// A recursion that cannot return without calling back into itself overflows the stack: it must not become a loop.
// A recursion with a way out keeps the loop the C compiler makes of it.
let sink = 0;
function a1(n: number): number { return a1(n + 1) + 1; }
function a2(): number { return a2(); }
function a3(): void { a3(); }
function a4(n: number): number { sink++; return a4(n) + 1; }
function a5(n: number): number { const r = a5(n + 1); return r; }
function a6(n: number): number { if (n > 0) { return a6(n + 1); } return a6(n + 2) + 1; }
function a7(n: number): number { return n % 2 ? a7(n + 1) : a7(n + 2); }
function b1(n: number): number { return b2(n) + 1; }
function b2(n: number): number { return b1(n) + 1; }
function s1(s: string): string { return s1(s + "x".slice(0, 0)); }
class C { m(n: number): number { return this.m(n + 1) + 1; } static s(n: number): number { return C.s(n + 1) + 1; } }
const arrow = (n: number): number => arrow(n + 1) + 1;
function outer() { let c = 0; function inner(): void { c++; inner(); } inner(); return c; }
function attempt(name: string, f: () => unknown) { try { console.log(name, f()); } catch (e: any) { console.log(name, e.name, e.message); } }
attempt("a1", () => a1(0));
attempt("a2", () => a2());
attempt("a3", () => a3());
attempt("a4", () => a4(0));
attempt("a5", () => a5(0));
attempt("a6", () => a6(0));
attempt("a7", () => a7(0));
attempt("b1", () => b1(0));
attempt("s1", () => s1("a"));
attempt("m", () => new C().m(0));
attempt("s", () => C.s(0));
attempt("arrow", () => arrow(0));
attempt("outer", () => outer());
console.log(sink > 1000);
function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
function sum(n: number, acc: number): number { return n === 0 ? acc : sum(n - 1, acc + n); }
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }
console.log(fib(20), sum(1000, 0), gcd(1071, 462));
