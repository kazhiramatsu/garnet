class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  sumXY(): number { return this.x; }   // typed field read inside a method
}
function make(): number {
  const p = new Point(3, 4);   // NoEscape, stable, determinable -> stack struct
  return p.sumXY();            // devirt mono -> Direct
}
