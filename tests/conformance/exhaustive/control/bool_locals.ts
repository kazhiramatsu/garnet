// Conditions on locals every definition of which is a boolean: comparison
// results, logical not, && / || chains, instanceof, boolean-returning calls,
// and copies of those. A boolean parameter (any may arrive), an any-typed
// value, a number and a string condition keep the general test.
class Box { constructor(public v: number) {} }
function isBig(n: number): boolean { return n > 100; }
function flags(a: number, b: number, s: string, o: unknown, p: boolean, q: any): number {
  let out = 0;
  const lt = a < b, eq = a === b, ne = s !== "x";
  if (lt) out += 1;
  if (!lt) out += 2;
  if (eq || ne) out += 4;
  if (lt && ne && !eq) out += 8;
  const inst = o instanceof Box;
  if (inst) out += 16;
  const big = isBig(a);
  if (big) out += 32;
  let flag = false;
  for (let i = 0; i < 5; i++) { if (i === a) flag = true; }
  if (flag) out += 64;
  const copy = flag; const copy2 = copy || big;
  if (copy2) out += 128;
  if (p) out += 256;          // a parameter: general test
  if (q) out += 512;          // any: general test (q may be 1, "s", {}, 0, "", null)
  const n = a - b; if (n) out += 1024;   // a number: truthiness, not a boolean compare
  if (s) out += 2048;         // a string: length test
  const t = !!q;              // double not: a boolean
  if (t) out += 4096;
  // a chain mixing a boolean with an object: the result is a union (the
  // comparison's own test is a boolean's), the result's test is general
  const picked = a < b && o;
  if (picked) out += 8192;
  const alt = s === "x" || o;
  if (alt) out += 16384;
  const both = a > b && o instanceof Box && s;
  if (both) out += 32768;
  return out;
}
function main() {
  const out: number[] = [];
  out.push(flags(1, 2, "y", new Box(1), true, 1), flags(2, 2, "x", {}, false, 0), flags(200, 1, "", null, true, "s"));
  out.push(flags(3, 9, "x", undefined, false, ""), flags(0, 0, "x", new Box(2), true, {}), flags(1, 5, "z", 7, true, null));
  console.log(JSON.stringify(out));
}
main();
