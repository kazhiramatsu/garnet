type ID = number;
type Name = string;
type Point = { x: number; y: number };
type Pair<T> = { first: T; second: T };
type StrOrNum = string | number;
type Handler = (n: number) => number;

function dist(p: Point): number { return p.x * p.x + p.y * p.y; }

function main(): void {
  const id: ID = 42;
  const nm: Name = "hi";
  const p: Point = { x: 3, y: 4 };
  const pr: Pair<number> = { first: 1, second: 2 };
  const v: StrOrNum = 7;
  const h: Handler = (n) => n * 2;
  console.log(id, nm, dist(p), pr.first + pr.second, v, h(10));
}
main();
