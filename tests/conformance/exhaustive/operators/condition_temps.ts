// Boolean temporaries that only feed conditions versus ones used as values:
// `&&`/`||` merges, `!` results, conditionally assigned flags, NaN, strings.
interface N { flags: number; name?: string; next?: N }
function conds(n: N, b: number, s: string): number {
  let c = 0;
  if (n.flags & 1 && !(b & 2)) c += 1;
  if (!n.name || b > 3) c += 2;
  if (n.flags > 0 && b < 10) c += 4;
  if (!!n.next && n.next.flags === 7) c += 8;
  if (s && s.length > 1) c += 16;
  if (!(n.flags & 4) || !!(b & 8)) c += 32;
  let ok;
  if (b > 5) ok = n.flags < 3;
  if (ok) c += 64;
  const nan = b - b + (b > 100 ? 0 : NaN); // NaN unless b > 100
  if (nan && n.flags) c += 128;
  if (!nan) c += 256;
  return c;
}
function values(n: N, b: number): any[] {
  const v1 = n.flags & 1 && !(b & 2);     // number or boolean as a value
  const v2 = !n.name || b > 3;             // boolean
  const v3 = n.flags > 0 && b < 10;        // boolean
  const v4 = !(b & 8);                      // boolean
  const v5 = n.name && n.name.length;       // string/undefined or number
  let v6; if (b > 5) v6 = n.flags < 3;      // boolean or undefined
  return [v1, v2, v3, v4, v5, v6, typeof v1, typeof v4, v2 === true, String(v3)];
}
function main(): void {
  const a: N = { flags: 1 }; const bN: N = { flags: 3, name: "xy", next: { flags: 7 } };
  for (const [n, b, s] of [[a, 1, ""], [bN, 7, "ab"], [bN, 9, "a"], [a, 11, "zz"], [bN, 101, "q"]] as [N, number, string][]) {
    console.log(conds(n, b, s), JSON.stringify(values(n, b)));
  }
}
main();
