class A { a: number; constructor(a: number) { this.a = a; } base(): number { return this.a; } }
class B extends A { b: number; constructor(a: number, b: number) { super(a); this.b = b; } }
class C extends B { constructor(a: number, b: number) { super(a, b); } sum(): number { return this.a + this.b; } }
function kernel(N: number): number {
  let s = 0; let i = 0;
  while (i < N) { const c = new C(i % 10, i % 7); s = (s + c.sum()) % 1000007; i = i + 1; }
  return s;
}
function main(): void { console.log(kernel(10000000)); }

main();
