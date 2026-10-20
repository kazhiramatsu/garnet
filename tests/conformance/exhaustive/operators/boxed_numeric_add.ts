// `+` of two number-typed operands where one is kept boxed (a nullable or
// maybe-undefined numeric: `s?.length ?? 0`, an element read, an optional
// field): numeric addition with ToNumber of the boxed side, NaN where an
// undefined reaches it, and string operands still concatenate.
interface Opt { x?: number; label?: string; }
function main(): void {
  const words: (string | undefined)[] = ["ab", undefined, "cde", undefined, "f"];
  let sum = 0;
  for (const w of words) sum += w?.length ?? 0;
  const arr: number[] = [1, 2, 3];
  let t = 0.5;
  for (let i = 0; i < 5; i++) t = t + (arr[i] ?? 10);
  const opts: Opt[] = [{ x: 1 }, {}, { x: 3, label: "L" }];
  let u = 0;
  for (const o of opts) u = u + (o.x ?? -1);
  let nan = 1;
  for (const w of words) nan = nan + (w?.length as number);
  const holes: number[] = [1, , 3] as any;
  let h = 0;
  for (let i = 0; i < 3; i++) h = h + holes[i];
  const mixed = sum + "/" + (words[0]?.length ?? 0) + (opts[2].label ?? "-");
  console.log(sum, t, u, nan, h, mixed, (words[1]?.length ?? 0) + (words[2]?.length ?? 0));
}
main();
