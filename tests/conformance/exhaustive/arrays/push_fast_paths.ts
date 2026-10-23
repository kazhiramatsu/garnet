// arr.push through the in-line store: within capacity, across growth, after
// `length` was set past the end, after holes, on a sparse array, with several
// arguments, the returned length, a frozen array (TypeError), and pushes of
// young values into an array that survived collections. (Sealed arrays, Array
// subclasses and a bracket-named call are `arrays/push_receivers`.)
function main() {
  const out: unknown[] = [];
  const a: number[] = [];
  let last = 0;
  for (let i = 0; i < 1000; i++) last = a.push(i * 2);
  out.push(last, a.length, a[0], a[999], a[1000]);
  const b: unknown[] = [1, 2];
  b.length = 5;
  out.push(b.push("x"), b.length, b[2], b[5], 2 in b, 4 in b);
  const c: number[] = [];
  c[10] = 1;
  out.push(c.push(7), c.length, c[11], c[0]);
  const d: number[] = [];
  d[100000] = 1;
  out.push(d.push(3), d.length, d[100001], d[50000]);
  const e: unknown[] = [];
  out.push(e.push(1, "two", null, undefined, [4]), e.length, JSON.stringify(e));
  const f = Object.freeze([1, 2, 3]) as number[];
  try { f.push(4); out.push("no throw"); } catch (err) { out.push((err as Error).constructor.name, f.length); }
  // an array that lives across many allocations receives fresh values
  const keep: number[][] = [];
  const old: object[] = [];
  for (let r = 0; r < 200; r++) {
    for (let i = 0; i < 500; i++) keep.push([i, r]);
    old.push({ r, len: keep.length });
    if (keep.length > 20000) keep.length = 0;
  }
  let sum = 0;
  for (const o of old) sum += (o as { r: number; len: number }).r + (o as { len: number }).len;
  out.push(old.length, sum);
  const anyArr = [] as any;
  anyArr.push(1);
  out.push(anyArr.length, anyArr[0]);
  console.log(JSON.stringify(out));
}
main();
