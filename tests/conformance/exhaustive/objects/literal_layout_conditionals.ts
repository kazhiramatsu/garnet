// An object literal whose values are conditional (`a ? b : c`, `??`, `||`, `&&`, `?.` lower to
// branches): its layout holds every key, the stores after a branch included, so the object is built
// with all its slots (vue's parser `getLoc`: `{ start, end: end == null ? end : pos(end), source }`).
// Key order, values, branches that allocate or call, and a branch that throws midway.
interface Pos { line: number; column: number }
const pos = (i: number): Pos => ({ line: (i / 10) | 0, column: i % 10 });
function getLoc(start: number, end?: number) {
  return { start: pos(start), end: end == null ? end : pos(end), source: end == null ? end : "s" + start + ":" + end };
}
function mixed(a: number, s: string | undefined, o: { n?: { m?: number } } | null) {
  return {
    first: a,
    pick: a > 2 ? "big" : "small",
    fallback: s ?? "none",
    either: s || "empty",
    both: a > 0 && s,
    deep: o?.n?.m,
    obj: a % 2 === 0 ? { even: true, half: a / 2 } : [a, a + 1],
    last: a * 10,
  };
}
const out: string[] = [];
for (let i = 0; i < 4000; i++) {
  const l = getLoc(i, i % 3 === 0 ? undefined : i + 5);
  if (i % 997 === 0) out.push(JSON.stringify(l), Object.keys(l).join(","));
  const m = mixed(i % 5, i % 2 === 0 ? undefined : i % 4 === 1 ? "" : "x" + i, i % 3 === 0 ? null : { n: i % 2 ? { m: i } : {} });
  if (i % 991 === 0) out.push(JSON.stringify(m), Object.keys(m).join(","), String(m.first + m.last));
}
function thrower(n: number): number { if (n === 7) throw new Error("boom"); return n; }
let caught = "";
for (let i = 0; i < 10; i++) {
  try {
    const o = { a: i, b: i > 5 ? thrower(i) : -1, c: "c" + i };
    caught += o.a + o.b + o.c + ";";
  } catch (e) { caught += "caught" + i + ";"; }
}
out.push(caught);
console.log(out.join("\n"));
