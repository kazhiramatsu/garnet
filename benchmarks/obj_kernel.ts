class Vec {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  dot(): number { return this.x * this.x + this.y * this.y; }
}
function kernel(N: number): number {
  let sum = 0;
  let i = 0;
  while (i < N) {
    const v = new Vec(i % 100, (i + 1) % 100);   // NoEscape -> stack struct
    sum = (sum + v.dot()) % 1000007;              // typed field access + devirt
    i = i + 1;
  }
  return sum;
}
function main(): void {
  console.log(kernel(50000000));
}

main();
