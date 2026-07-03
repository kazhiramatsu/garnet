const a = 99;
class A {
  a: number = 1;
  foo(): number { return a; }
  both(): number { return this.a + a; }
}
function main(): void {
  const obj = new A();
  console.log(obj.foo());
  console.log(obj.both());
}
main();
