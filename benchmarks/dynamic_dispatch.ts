class Calc { base: number; constructor(b: number) { this.base = b; } add(): number { return this.base + 10; } }
function main(): void {
  const c: any = new Calc(5);   // any -> dynamic dispatch
  console.log(c.add());          // 15 (original method via prototype lookup)
}

main();
