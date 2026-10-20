// Callbacks of the array iteration methods and of Map/Set forEach receive the
// container as their last argument (reduce: (acc, value, index, array)), and a
// callback resolved once for the whole loop (the builtin's fast call) keeps
// every semantic: a callback calling another closure (the environment
// register changes under it), a `function` callback (takes `this`), a callback
// that throws, one that grows, shrinks or punches holes into the array, and a
// method value.
function main(): void {
  const arr = [10, 20, 30];
  const out: string[] = [];
  arr.forEach((x, i, a) => { out.push(`${x}/${i}/${a.length}`); });
  const m = arr.map((x, i, a) => x + i + a.length);
  const f = arr.filter((x, i, a) => a[i] === x && i > 0);
  const s = arr.some((x, i, a) => a === arr && x > 25);
  const e = arr.every((x, i, a) => a.length === 3);
  const fi = arr.find((x, i, a) => a[a.length - 1] === x);
  const fx = arr.findIndex((x, i, a) => a[0] + x === 40);
  const fl = arr.findLast((x, i, a) => a.indexOf(x) === 0);
  const fli = arr.findLastIndex((x, i, a) => x === a[1]);
  const fm = arr.flatMap((x, i, a) => [x, a.length]);
  const r = arr.reduce((acc, x, i, a) => acc + x * a.length + i, 0);
  const rr = arr.reduceRight((acc, x, i, a) => acc + "," + x + ":" + (a === arr), "");
  const map = new Map<string, number>([["a", 1], ["b", 2]]);
  const mo: string[] = []; map.forEach((v, k, mm) => { mo.push(`${k}${v}${mm.size}`); });
  const set = new Set<number>([5, 6]);
  const so: string[] = []; set.forEach((v, v2, ss) => { so.push(`${v}${v2}${ss.has(v)}`); });
  console.log(out.join(","), m.join(","), f.join(","), s, e, fi, fx, fl, fli, fm.join(","), r, rr, mo.join(","), so.join(","));

  // a callback that calls other closures: each sets the environment register
  let calls = 0;
  const helpers = [1, 2, 3].map((k) => (x: number) => { calls++; return x * k; });
  const sums = arr.map((x) => helpers[0](x) + helpers[1](x) + helpers[2](x) + calls);
  // a `function` callback (reads this: undefined in strict mode)
  const kinds = arr.map(function (this: unknown, x: number) { return typeof this + x; });
  // throwing in the middle
  let seen = 0;
  try { arr.forEach((x) => { seen++; if (x === 20) throw new Error("stop at " + x); }); } catch (err) { out.push((err as Error).message); }
  // mutation during iteration: visits see the length at the start, holes skipped
  const grow = [1, 2, 3]; const visited: number[] = [];
  grow.forEach((x, i, a) => { visited.push(x); if (i === 0) { a.push(99); delete a[2]; } });
  const shrink = [1, 2, 3, 4]; const sv: number[] = [];
  shrink.forEach((x, i, a) => { sv.push(x); if (i === 1) a.length = 2; });
  // a method value as the callback (no this in the call)
  const strs = ["a", "bb", "ccc"].map(String.prototype.toUpperCase.call.bind(String.prototype.toUpperCase));
  console.log(sums.join(","), calls, kinds.join(","), seen, out[out.length - 1], visited.join(","), grow.length, sv.join(","), strs.join(","));
}
main();
