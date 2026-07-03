class P { x: number; constructor(x: number) { this.x = x; } }
function readVia(p: P): number { return p.x; }   // param -> dynamic ts_get?
function main(): void {
  const p = new P(777);
  console.log(readVia(p));   // V8: 777
}

main();
