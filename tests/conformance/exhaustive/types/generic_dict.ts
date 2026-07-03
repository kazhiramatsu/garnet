function keys<T extends object>(o: T): (keyof T)[] { return Object.keys(o) as (keyof T)[]; }
function values<T>(o: Record<string, T>): T[] { return Object.keys(o).map(k => o[k]); }
function mapValues<T, U>(o: Record<string, T>, f: (t: T) => U): Record<string, U> {
  const out: Record<string, U> = {};
  for (const k of Object.keys(o)) out[k] = f(o[k]);
  return out;
}
function pick<T, K extends keyof T>(o: T, ks: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of ks) out[k] = o[k];
  return out;
}
function main(): void {
  const o = { a: 1, b: 2, c: 3 };
  console.log(keys(o).sort().join(","));                       // a,b,c
  console.log(values(o).reduce((a, b) => a + b, 0));          // 6
  const d = mapValues(o, v => v * 10);
  console.log(d.a, d.b, d.c);                                  // 10 20 30
  const p = pick({ x: 1, y: 2, z: 3 }, ["x", "z"]);
  console.log(p.x, p.z);                                       // 1 3
}
main();
