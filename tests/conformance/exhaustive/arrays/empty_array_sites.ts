// An empty array literal is allocated in line at its site (the four inline slots holes, as the
// runtime's own empty array). What is done to it next must not tell: pushes within and past the
// inline slots, stores below and far past the length, the length written, holes read, iteration,
// spreads, an array kept long enough for its site to turn tenured (the allocation then leaves for
// the runtime, with the barrier an old array needs), and a typed `for..of` over what is not an array.
function grow(n: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i * 3);
  return a;
}
function stored(at: number): (number | undefined)[] {
  const a: (number | undefined)[] = [];
  a[at] = at;
  return a;
}
function describe(a: readonly unknown[]): string {
  let holes = 0;
  for (let i = 0; i < a.length; i++) if (!(i in a)) holes++;
  return a.length + ":" + holes + ":" + JSON.stringify(a);
}
function main(): void {
  for (const n of [0, 1, 3, 4, 5, 8, 9, 33]) console.log("grow", n, describe(grow(n)));
  for (const at of [0, 1, 3, 4, 7, 40]) console.log("stored", at, describe(stored(at)));

  const e: string[] = [];
  console.log("empty", e.length, Array.isArray(e), e[0], e.at(-1), 0 in e, e.join("-") === "", JSON.stringify([...e, ...e]));
  e.length = 3;
  console.log("lengthened", describe(e), e.indexOf(undefined as never), e.includes(undefined as never));
  e.length = 0;
  e.unshift("b"); e.unshift("a"); e.splice(1, 0, "x", "y", "z");
  console.log("edited", describe(e), e.pop(), e.shift(), describe(e));

  // an empty array per round, most of them kept: the site sees its arrays survive collections
  const kept: number[][] = [];
  let sum = 0;
  for (let r = 0; r < 60000; r++) {
    const row: number[] = [];
    if (r % 3 !== 0) kept.push(row);
    row.push(r); if (r % 5 === 0) { row.push(r + 1); row.push(r + 2); row.push(r + 3); row.push(r + 4); }
    const scratch: string[] = [];
    scratch.push("s" + r);
    sum = (sum + row.length + scratch[0]!.length) % 1000003;
  }
  let total = 0;
  for (const row of kept) for (const v of row) total = (total + v) % 1000003;
  console.log("kept", kept.length, sum, total, kept[0]!.length, kept[39999]!.length, kept[39999]![0]);

  // nested empties and empties as arguments, fields and elements
  const grid: number[][] = [];
  for (let i = 0; i < 6; i++) { grid.push([]); for (let j = 0; j < i; j++) grid[i]!.push(i * j); }
  console.log("grid", JSON.stringify(grid));
  const box = { list: [] as string[], more: [[]] as string[][] };
  box.list.push("p"); box.more[0]!.push("q"); box.more.push([]);
  console.log("box", JSON.stringify(box), [[], [[]], []].length, ([] as number[]).concat([], [1], []).length);

  // a typed for..of over a value that is not an array behind the type
  const set = new Set([5, 6, 7]);
  let seen = 0;
  for (const v of set as unknown as number[]) seen += v;
  let over = 0;
  for (const v of [] as number[]) over += v;
  console.log("forof", seen, over);
}
main();
