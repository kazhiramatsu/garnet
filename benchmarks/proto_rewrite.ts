class Calc { base: number; constructor(b: number) { this.base = b; } compute(): number { return this.base; } }
function run(c: Calc): number { return c.compute(); }
function main(): void {
  const c = new Calc(5);
  (Calc.prototype as any).compute = function() { return 99; };  // rewrite -> dynamic
  console.log(run(c));   // 99 (rewritten method via prototype)
}

main();
