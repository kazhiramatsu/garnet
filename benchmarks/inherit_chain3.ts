class A { a(): number { return 1; } }
class B extends A { b(): number { return 2; } }
class C extends B { c(): number { return 3; } }
function main(): void {
  const o = new C();
  console.log(o.a() + o.b() + o.c());   // 6 (a inherited from A, b from B, c own)
}

main();
