class A { x: number; constructor(x: number) { this.x = x; } }
class B extends A { constructor() { super(2); } }
function main(): void {
  const b = new B();
  const a = new A(1);
  let r = 0;
  if (b instanceof B) { r = r + 1; }
  if (b instanceof A) { r = r + 10; }
  if (!(a instanceof B)) { r = r + 100; }
  console.log(r);   // 111
}

main();
