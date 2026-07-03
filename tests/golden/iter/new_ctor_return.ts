class A { x: number; constructor() { this.x = 1; return { x: 99, y: 5 } as any; } }
class B { x: number; constructor() { this.x = 7; return 42 as any; } }
class C { x: number; constructor() { this.x = 3; } }
class D { x: number; constructor() { this.x = 8; return [1, 2, 3] as any; } }  // array is object-like
function main(): void {
  const a: any = new A(); console.log(a.x, a.y);     // 99 5
  const b: any = new B(); console.log(b.x);          // 7  (primitive return ignored)
  const c: any = new C(); console.log(c.x);          // 3
  const d: any = new D(); console.log(d.length, d[0]); // 3 1 (array return used)
}

main();
