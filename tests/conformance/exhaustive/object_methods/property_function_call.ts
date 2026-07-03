function main(): void {
  // a plain function-valued property is callable via method syntax
  const o: any = { f: () => 5, g(): number { return 6; } };
  console.log(o.f(), o.g());               // 5 6
  // data property overwrites a method (last wins, single namespace)
  const o2: any = { m() { return 1; }, m: 2 };
  console.log(o2.m);                       // 2
}
main();
