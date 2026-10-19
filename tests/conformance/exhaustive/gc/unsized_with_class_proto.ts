// Plain objects whose prototype carries a registered class layout (relinked
// with Object.setPrototypeOf, read only through `any`: typed access would
// assume the struct layout they do not have), objects of a field-less class,
// sized instances of the same classes, and closure environment records, all
// holding young references across many collections: every value must survive.
class Point { x: number; y: number; tag: string; constructor(x: number, y: number, tag: string) { this.x = x; this.y = y; this.tag = tag; } sum(): number { return this.x + this.y; } }
class Empty {}
interface Bag { _b?: any; items?: number[]; name?: string; link?: Bag; }
const EmptyBag = class implements Bag { declare _b: any; };
function churn(n: number): number { let s = 0; for (let i = 0; i < n; i++) { const a = [i, i + 1, { v: i }]; s += (a[2] as { v: number }).v & 1; } return s; }
function makeCounter(step: number): () => number { let n = 0; const bump = () => { n += step; return n; }; return bump; }
function main(): void {
  const protoBacked: any[] = [];
  const sized: Point[] = [];
  const bags: Bag[] = [];
  const counters: (() => number)[] = [];
  for (let i = 0; i < 4000; i++) {
    const p: any = { x: i, y: 2 * i, tag: "t" + (i & 15) };   // unsized object ...
    Object.setPrototypeOf(p, Point.prototype);                   // ... behind a class prototype
    protoBacked.push(p);
    sized.push(new Point(i, -i, "s" + (i & 7)));          // sized instance
    const b: Bag = new EmptyBag(); b.items = [i, i + 1]; b.name = "b" + (i & 3); if (i > 0) b.link = bags[i - 1];
    bags.push(b);
    counters.push(makeCounter(i & 3));
    if ((i & 255) === 0) churn(20000);
  }
  churn(200000);
  let acc = 0, ok = 0;
  for (let i = 0; i < 4000; i++) {
    const p = protoBacked[i]; const s = sized[i]; const b = bags[i];
    if (p.x + p.y === 3 * i && p.tag === "t" + (i & 15) && p instanceof Point && Object.getPrototypeOf(p) === Point.prototype) ok++;
    if (s.sum() === 0 && s.tag === "s" + (i & 7)) ok++;
    if (b.items![0] === i && b.items![1] === i + 1 && b.name === "b" + (i & 3) && (i === 0 || b.link === bags[i - 1])) ok++;
    acc += counters[i]() + counters[i]();
  }
  // a subclass prototype is itself an unsized object behind a prototype with fields
  class Sub extends Point { constructor() { super(1, 2, "sub"); } }
  (Sub.prototype as any).cache = [protoBacked[9], sized[9]]; churn(60000);
  const sub = new Sub(); const cache = (Sub.prototype as any).cache as [any, Point];
  const e = new Empty(); (e as any).late = protoBacked[7]; churn(50000);
  console.log(ok, acc, (e as any).late.x + (e as any).late.y, Object.keys(protoBacked[3]).join(","), Object.keys(sized[3]).join(","), Object.keys(bags[3]).join(","));
  console.log(sub.sum(), sub instanceof Point, cache[0].x + cache[0].y, cache[1].sum(), Object.keys(Sub.prototype).join(","), "x" in protoBacked[3], Object.prototype.hasOwnProperty.call(protoBacked[3], "x"), JSON.stringify(protoBacked[2]));
}
main();
