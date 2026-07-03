class Point { x: number; constructor(x: number) { this.x = x; } }
function sink(p: Point): number { return p.x; }
function kernel(N: number): number {
  let sum = 0; let i = 0;
  while (i < N) {
    const p = new Point(i % 100);
    sum = (sum + sink(p)) % 1000007;   // p escapes into sink -> not SROA'd
    i = i + 1;
  }
  return sum;
}
function main(): void { console.log(kernel(20000000)); }

main();
