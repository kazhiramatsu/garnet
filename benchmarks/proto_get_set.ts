class A { m(): number { return 1; } }
class B { m(): number { return 2; } }
function main(): void {
  const a = new A();
  const before = Object.getPrototypeOf(a);
  Object.setPrototypeOf(a, B.prototype);
  const after = Object.getPrototypeOf(a);
  console.log(before === after ? 0 : 1);   // 1 (proto changed)
  console.log((a as any).m());             // 2
}

main();
