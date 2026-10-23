// Locals read before any assignment on some path read undefined: declared without an
// initializer and assigned in one arm, in a loop body (the first iteration reads the
// previous value), in a try whose body throws before the assignment, in a finally, and
// captured by a closure created before the assignment.
function pick(c: boolean): string {
  let a: number | undefined;
  let b: string | undefined;
  if (c) { a = 1; b = "set"; }
  return `${a}:${b}`;
}
function loopCarried(n: number): string {
  let prev: number | undefined;
  const out: string[] = [];
  for (let i = 0; i < n; i++) { out.push(String(prev)); prev = i * 2; }
  return out.join(",");
}
function thrown(flag: boolean): string {
  let v: number | undefined;
  let w: number | undefined;
  try {
    if (flag) throw new Error("x");
    v = 5;
  } catch (e) {
    w = v === undefined ? -1 : v;
  } finally {
    if (w === undefined) w = 7;
  }
  return `${v}/${w}`;
}
function captured(): string {
  let late: string | undefined;
  const f = () => String(late);
  const before = f();
  late = "now";
  return before + "," + f();
}
function whileFirst(): number {
  let acc: number | undefined;
  let k = 0;
  while (k < 3) { acc = (acc === undefined ? 10 : acc) + k; k++; }
  return acc!;
}
function main(): void {
  console.log(pick(true), pick(false), loopCarried(3), thrown(true), thrown(false), captured(), whileFirst());
}
main();
