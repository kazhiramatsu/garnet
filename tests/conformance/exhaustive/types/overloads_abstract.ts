function fmt(x: number): string;
function fmt(x: string): string;
function fmt(x: number | string): string { return typeof x === "number" ? "n:" + x : "s:" + x; }

abstract class Shape { abstract area(): number; describe(): string { return "area=" + this.area(); } }
class Sq extends Shape { constructor(private s: number) { super(); } area(): number { return this.s * this.s; } }

interface Lookup { [key: string]: number; }
type Tup = [number, string, boolean];

function main(): void {
  console.log(fmt(5), fmt("hi"));            // n:5 s:hi
  const sq = new Sq(4);
  console.log(sq.area(), sq.describe());      // 16 area=16
  const l: Lookup = { a: 1, b: 2 };
  console.log(l["a"] + l["b"]);               // 3
  const tup: Tup = [1, "x", true];
  console.log(tup[0], tup[1], tup[2]);        // 1 x true
}
main();
