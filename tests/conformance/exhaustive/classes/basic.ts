class Point {
  x: number; y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  dist(): number { return Math.sqrt(this.x * this.x + this.y * this.y); }
  toString(): string { return `(${this.x},${this.y})`; }
}
function main(): void {
  const p = new Point(3, 4);
  console.log(p.dist(), p.toString(), p.x + p.y);
}

main();
