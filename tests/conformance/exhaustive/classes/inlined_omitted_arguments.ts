// Calls the optimizer inlines (a constructor of a non-escaping object, a
// small function) that omit trailing arguments: each omitted parameter is
// undefined, its default applies, `??` sees undefined. It used to name an
// unrelated local of the caller (reading, say, a class's prototype).
class B {
  readonly v: string;
  constructor(base: string, flag?: boolean, suffix = "-") { this.v = base + String(flag ?? "none") + suffix; }
}
class C {
  readonly sum: number;
  constructor(a: number, b?: number) { this.sum = a + (b ?? 100); }
}
function pick(a: string, b?: string): string { return b ?? a; }
function count(...xs: number[]): number { return xs.length; }
function main(): void {
  const p = { x: 1 };
  console.log(new B("x").v, new B("y", false).v, new B("z", true, "+").v);
  console.log(new C(1).sum, new C(1, 2).sum, pick("a"), pick("a", "b"), count(), count(1, 2), p.x);
  let total = 0;
  for (let i = 0; i < 3; i++) total += new C(i).sum;
  console.log(total);
}
main();
