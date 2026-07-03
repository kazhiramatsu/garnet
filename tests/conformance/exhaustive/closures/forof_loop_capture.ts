// A closure that captures a `for-of` loop variable must observe each iteration's
// value (JS per-iteration binding semantics, like captured `let` in a for-loop).
// Previously the for-of element was written to a raw local, bypassing the capture
// cell, so closures saw an empty/undefined value. Now every for-of variant (array,
// string, Set, Map, generator/iterator) and binding form (identifier, array /
// object destructuring) allocates a fresh per-iteration cell.
function* gen(): Generator<string> { yield "x"; yield "y"; yield "z"; }

function main(): void {
  // identifier capture over an array
  const a: (() => string)[] = [];
  for (const k of ["a", "b", "c"]) a.push(() => k);
  console.log(a.map((f) => f()).join(",")); // a,b,c

  // captured + used immediately in the same iteration
  const r: string[] = [];
  for (const k of ["p", "q"]) { const f = () => k; r.push(f()); }
  console.log(r.join(",")); // p,q

  // stored under a dynamic key, called later
  const o: any = {};
  for (const k of ["x", "y"]) o["get_" + k] = () => k;
  console.log(o.get_x(), o.get_y()); // x y

  // string iteration (code points)
  const s: (() => string)[] = [];
  for (const c of "ab") s.push(() => c);
  console.log(s.map((f) => f()).join(",")); // a,b

  // Set
  const st: (() => string)[] = [];
  for (const x of new Set(["m", "n"])) st.push(() => x);
  console.log(st.map((f) => f()).join(",")); // m,n

  // generator / iterator protocol
  const g: (() => string)[] = [];
  for (const v of gen()) g.push(() => v);
  console.log(g.map((f) => f()).join(",")); // x,y,z

  // array destructuring capture
  const d: (() => number)[] = [];
  for (const [p, q] of [[1, 2], [3, 4]]) d.push(() => p + q);
  console.log(d.map((f) => f()).join(",")); // 3,7

  // object destructuring capture
  const od: (() => number)[] = [];
  for (const { x, y } of [{ x: 1, y: 2 }, { x: 3, y: 4 }]) od.push(() => x * y);
  console.log(od.map((f) => f()).join(",")); // 2,12

  // Map iteration with destructuring capture
  const m = new Map<string, number>([["a", 1], ["b", 2]]);
  const mc: (() => string)[] = [];
  for (const [key, val] of m) mc.push(() => key + val);
  console.log(mc.map((f) => f()).join(",")); // a1,b2

  // .entries() with destructuring capture
  const ec: (() => string)[] = [];
  for (const [i, v] of ["q", "r"].entries()) ec.push(() => i + ":" + v);
  console.log(ec.map((f) => f()).join(",")); // 0:q,1:r

  // regression: non-captured for-of and for-let still work
  let sum = "";
  for (const k of ["1", "2", "3"]) sum += k;
  console.log(sum); // 123
  const li: (() => number)[] = [];
  for (let i = 0; i < 3; i++) li.push(() => i);
  console.log(li.map((f) => f()).join(",")); // 0,1,2
}
main();
