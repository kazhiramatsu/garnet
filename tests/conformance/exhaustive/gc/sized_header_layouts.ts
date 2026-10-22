// Sized class instances keep their struct extent in the cell header
// (docs/cell_header_design.md). Header-only instances relinked behind a
// field-bearing prototype and accessed through its typed fields, factories and
// subclasses, `delete` that converts an instance, absent and refused deletes,
// attribute changes and dynamic properties on old instances: every field read
// stays exact, before and after collections. (Sized instances relinked behind
// another class's prototype: sized_header_relinks.ts.)
class A1 { a: any; constructor(i: number) { this.a = { v: i }; } }
class A2 { a: any; b: any; constructor(i: number) { this.a = { v: i }; this.b = "b" + i; } }
class A3 {
  a: any; b: any; c: any;
  constructor(i: number) { this.a = { v: i }; this.b = "b" + i; this.c = [i]; }
  getC(): any { return this.c; }      // typed accesses of `this`: a foreign receiver takes the slow path
  setC(v: any): void { this.c = v; }
}
class A4 { a: any; b: any; c: any; d: any; constructor(i: number) { this.a = { v: i }; this.b = "b" + i; this.c = [i]; this.d = i * 2; } }
class A5 { a: any; b: any; c: any; d: any; e: any; constructor(i: number) { this.a = { v: i }; this.b = "b" + i; this.c = [i]; this.d = i * 2; this.e = null; } }
class Empty0 { hello(): string { return "empty"; } }
class B3 extends A3 { d: any; e: any; constructor(i: number) { super(i); this.d = { w: i }; this.e = "e" + i; } }
class Num2 { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }

function churn(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) { const t = { a: i, b: [i, i + 1] }; s = (s + t.a + t.b.length) % 1000; }
  return s;
}
function make3(i: number): A3 { return new A3(i); }
function makeB(i: number): A3 { return new B3(i); }
function readC(x: A3): any { return x.c; }
function writeC(x: A3, v: any): void { x.c = v; }
function readD(x: A4): any { return x.d; }
function readE(x: A5): any { return x.e; }
function show(v: any): string {
  if (v === undefined) return "u";
  if (v === null) return "n";
  if (Array.isArray(v)) return "[" + v.join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).map((k) => k + ":" + show(v[k])).join(",") + "}";
  return String(v);
}

function main(): void {
  const keep: any[] = [];
  const n = 64;
  const a1s: A1[] = [], a2s: A2[] = [], a3s: A3[] = [], a4s: A4[] = [], a5s: A5[] = [], bs: A3[] = [];
  const empties: Empty0[] = [], nums: Num2[] = [];
  for (let i = 0; i < n; i++) {
    a1s.push(new A1(i)); a2s.push(new A2(i)); a3s.push(make3(i)); a4s.push(new A4(i)); a5s.push(new A5(i));
    bs.push(makeB(i)); empties.push(new Empty0()); nums.push(new Num2(i, -i));
  }
  let s = churn(300000);   // the instances above are old now

  // 1. header-only instances relinked behind field-bearing prototypes: read
  //    and written through the class's typed fields and its methods
  const hdr: string[] = [];
  for (let i = 0; i < 6; i++) {
    const e: any = empties[i];
    Object.setPrototypeOf(e, A3.prototype);
    hdr.push(show(readC(e)) + show((e as A3).getC()));
    if (i < 3) writeC(e, ["e", i]); else (e as A3).setC(["m", i]);
  }
  s += churn(200000);
  for (let i = 0; i < 6; i++) hdr.push(show(readC(empties[i] as any)) + show((empties[i] as any as A3).getC()) + show((empties[i] as any).a));
  console.log("header-only", hdr.join(" "), (empties[8] as Empty0).hello(), show(a3s[40].getC()));

  // 2. subclasses read through the base layout; factories feed both
  let sub = "";
  for (let i = 0; i < 6; i++) sub += show(readC(bs[i])) + show((bs[i] as B3).d) + show((bs[i] as B3).e) + ";";
  console.log("subclass", sub);

  // 3. delete: converts an old instance; absent and refused deletes leave it alone
  const conv: string[] = [];
  for (let i = 8; i < 12; i++) {
    const x: any = a3s[i];
    const absent = delete x.nothing;
    x.dyn = { d: i };
    conv.push(String(absent) + show(readC(x)) + show(x.dyn));
  }
  s += churn(100000);
  for (let i = 8; i < 12; i++) {
    const x: any = a3s[i];
    const gone = delete x.b;
    conv.push(String(gone) + show(x.a) + show(x.b) + show(readC(x)) + show(x.dyn) + Object.keys(x).join(","));
  }
  s += churn(200000);
  for (let i = 8; i < 12; i++) { const x: any = a3s[i]; x.a = { again: i }; conv.push(show(x.a) + show(readC(x))); }
  s += churn(200000);
  for (let i = 8; i < 12; i++) { const x: any = a3s[i]; conv.push(show(x.a) + show(x.c) + show(x.dyn)); }
  console.log("delete", conv.join(" "));

  const frozen: any = a4s[20];
  Object.freeze(frozen);
  let refused = "";
  try { delete frozen.a; refused = "deleted"; } catch (e) { refused = e instanceof TypeError ? "TypeError" : "other"; }
  s += churn(100000);
  console.log("refused", refused, show(frozen.a), show(readD(frozen)), Object.isFrozen(frozen));

  // 4. attribute changes and dynamic properties on old instances
  const attr: any = a5s[30];
  Object.defineProperty(attr, "extra", { value: { x: 1 }, enumerable: false, writable: true, configurable: true });
  attr.more = [1, 2, 3];
  s += churn(200000);
  attr.extra = { x: 2 };
  delete attr.more;
  s += churn(200000);
  console.log("attributes", show(attr.extra), show(attr.more), Object.keys(attr).join(","), show(readE(attr)), show(attr.a));

  // 5. numeric fields beside the rest
  let sum = 0;
  for (let i = 0; i < n; i++) sum += nums[i].x - nums[i].y;
  for (let i = 0; i < n; i++) { const x: any = nums[i]; if (i % 7 === 0) x.tag = "t" + i; }
  s += churn(200000);
  let tags = "";
  for (let i = 0; i < n; i += 7) tags += (nums[i] as any).tag + (nums[i].x + nums[i].y);
  console.log("numbers", sum, tags);

  // 6. every untouched old instance still reads its own fields
  let check = 0;
  for (let i = 32; i < n; i++) {
    check += a1s[i].a.v + a2s[i].b.length + a3s[i].c[0] + a4s[i].d + (a5s[i].e === null ? 1 : 0) + (bs[i] as B3).d.w;
  }
  keep.push(a1s, a2s, a3s, a4s, a5s, bs, empties, nums);
  console.log("intact", check, keep.length, s >= 0);
}
main();
