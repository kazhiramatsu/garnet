class C { a: number; b: number; constructor() { this.a = 1; this.b = 2; } }
function main(): void {
  const o: any = { x: 10, y: "hi", z: true };
  for (const p of Object.entries(o)) console.log(p[0], p[1]);
  console.log(Object.entries(o).length);
  const c: any = new C();
  for (const p of Object.entries(c)) console.log(p[0], p[1]);
  console.log(Object.entries({}).length);
  const sum = Object.entries({ a: 1, b: 2, c: 3 }).reduce((acc: number, p: any) => acc + p[1], 0);
  console.log(sum);
  // keys/values on class instance too
  console.log(Object.keys(c).join(","), Object.values(c).join(","));
}

main();
