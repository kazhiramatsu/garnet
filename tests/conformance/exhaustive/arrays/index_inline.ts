// Element reads through the inline fast path: in-range elements, holes,
// out-of-range and negative indices, strings, nested arrays, growth,
// truncation and re-extension (holes).
function main(): void {
  const a: number[] = [10, 20, 30];
  const h: (number | undefined)[] = [1, , 3];
  console.log(a[0], a[2], a[3], a[-1], h[1], h[0], h[2], h[5]);
  let sum = 0;
  for (let i = 0; i < 100; i++) sum += a[i % 3];
  console.log(sum);
  const s = "héllo";
  console.log(s[0], s[1], s[4], s[5], s[-1]);
  const objs: { k: number }[] = [];
  for (let i = 0; i < 5; i++) objs.push({ k: i * i });
  let t = 0;
  for (let i = 0; i < objs.length; i++) t += objs[i].k;
  console.log(t, objs[7] === undefined);
  const nested: number[][] = [[1, 2], [3]];
  console.log(nested[1][0], nested[0][1], nested[2]);
  const mixed: unknown[] = [undefined, null, "s", 1.5];
  for (let i = 0; i < 5; i++) console.log(i, mixed[i]);
  const g: number[] = [];
  for (let i = 0; i < 20; i++) g.push(i);
  g.length = 5;
  console.log(g[4], g[5], g[19]);
  g.length = 8;
  console.log(g[2], g[6], 6 in g, g.length);
  const idx = 1;
  console.log(a[idx], a[idx + 1], a[idx * 3]);
  // reads inside a function that cannot allocate (lazy frame) and one that can
  function first(xs: number[]): number { return xs[0]; }
  function firstOrPush(xs: number[]): number { if (xs.length === 0) xs.push(7); return xs[0]; }
  console.log(first(a), firstOrPush([]), firstOrPush(a));
}
main();
