// Sized class instances relinked behind another class's prototype
// (docs/cell_header_design.md): their layout is their allocation class's, found
// through the class index word, never a larger one that shares their size
// class. Reads and typed writes of the other class's fields, before and after
// collections. (With TSAOT_CLASS_INDEX=0 a relinked instance's layout follows
// its new prototype: tests/cell_header_gate.sh leaves this fixture out there.)
class A1 { a: any; constructor(i: number) { this.a = { v: i }; } }
class A2 { a: any; b: any; constructor(i: number) { this.a = { v: i }; this.b = "b" + i; } }
class A3 { a: any; b: any; c: any; constructor(i: number) { this.a = { v: i }; this.b = "b" + i; this.c = [i]; } }
class A4 { a: any; b: any; c: any; d: any; constructor(i: number) { this.a = { v: i }; this.b = "b" + i; this.c = [i]; this.d = i * 2; } }
class A5 { a: any; b: any; c: any; d: any; e: any; constructor(i: number) { this.a = { v: i }; this.b = "b" + i; this.c = [i]; this.d = i * 2; this.e = null; } }

function churn(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) { const t = { a: i, b: [i, i + 1] }; s = (s + t.a + t.b.length) % 1000; }
  return s;
}
function readB(x: A2): any { return x.b; }
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
  const n = 16;
  const a1s: A1[] = [], a2s: A2[] = [], a3s: A3[] = [], a4s: A4[] = [], a5s: A5[] = [];
  for (let i = 0; i < n; i++) { a1s.push(new A1(i)); a2s.push(new A2(i)); a3s.push(new A3(i)); a4s.push(new A4(i)); a5s.push(new A5(i)); }
  let s = churn(300000);   // old now

  // smaller layouts behind larger prototypes: the extra field is absent
  const rel: string[] = [];
  for (let i = 0; i < 4; i++) {
    const x1: any = a1s[i]; Object.setPrototypeOf(x1, A2.prototype);
    const x2: any = a2s[i]; Object.setPrototypeOf(x2, A3.prototype);
    const x3: any = a3s[i]; Object.setPrototypeOf(x3, A4.prototype);
    const x4: any = a4s[i]; Object.setPrototypeOf(x4, A5.prototype);
    rel.push(show(readB(x1)) + "/" + show(readC(x2)) + "/" + show(readD(x3)) + "/" + show(readE(x4)) + "/" + show(x2.c));
  }
  console.log("relinked", rel.join(" "));
  // ... written through the typed field: an own property appears, the fields stay
  for (let i = 0; i < 4; i++) writeC(a2s[i] as any, { late: i });
  s += churn(200000);
  const late: string[] = [];
  for (let i = 0; i < 4; i++) late.push(show(readC(a2s[i] as any)) + show((a2s[i] as any).a) + show((a2s[i] as any).b));
  console.log("relinked writes", late.join(" "), Object.keys(a2s[0]).join(","));

  // larger layouts behind smaller prototypes keep every field
  const big: string[] = [];
  for (let i = 4; i < 8; i++) {
    const x5: any = a5s[i]; Object.setPrototypeOf(x5, A2.prototype);
    big.push(show(readB(x5)) + show(x5.c) + show(x5.d) + show(x5.e) + Object.keys(x5).join(""));
    x5.e = { set: i };
  }
  s += churn(200000);
  for (let i = 4; i < 8; i++) big.push(show((a5s[i] as any).e) + show(readE(a5s[i])));
  console.log("relinked larger", big.join(" "));

  // relinked back: the original layout reads as before
  for (let i = 0; i < 4; i++) Object.setPrototypeOf(a3s[i], A3.prototype);
  s += churn(100000);
  let back = "";
  for (let i = 0; i < 4; i++) back += show(readC(a3s[i])) + show(a3s[i].a) + ";";
  console.log("relinked back", back, s >= 0);
}
main();
