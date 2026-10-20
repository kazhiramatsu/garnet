// Number keys that are not array indices (docs/array_index_keys_design.md §2):
// an index is an integer in [0, 2^32 - 1); any other number is a property key
// under ToString ("-1", "1.5", "4294967295", "NaN"), and -0 is element 0. The
// element path used to truncate the key (a[1.5] read a[1], a[2^32 + 1] read
// a[1]) and to throw RangeError on stores of non-index keys.
function readInt(a: number[], i: number): number | undefined { return a[i]; }
function writeInt(a: number[], i: number, v: number): void { a[i] = v; }
function main(): void {
  const a = [10, 20, 30];
  // integer keys (int-specialized locals)
  let neg = -1, big = 4294967296 + 1, last = 4294967295, top = 4294967294;
  console.log(a[neg], a[big], a[last], a[top], a[0], a[2], a[3]);
  // double keys
  const h = 1.5, nan = NaN, inf = Infinity, mz = -0;
  console.log(a[h], a[nan], a[inf], a[mz], a[2.0]);
  // stores of non-index keys create named properties; index stores stay elements
  const w = [1, 2, 3];
  w[h] = 7; w[neg] = 8; w[last] = 9; w[nan] = 11; w[mz] = 100;
  console.log(w.join(","), w.length, (w as any)["1.5"], (w as any)["-1"], (w as any)["4294967295"], (w as any)["NaN"]);
  console.log(Object.keys(w).join(","));
  console.log(h in w, neg in w, 5 in w, 2 in w, delete (w as any)[h], h in w);
  // keys computed in loops (double and int)
  let s = 0;
  for (let i = -1; i < 4; i += 0.5) s += a[i] === undefined ? 1000 : a[i];
  for (let i = -2; i < 5; i++) s += a[i] === undefined ? 1 : a[i];
  console.log(s);
  // through functions (number parameters)
  console.log(readInt(a, -1), readInt(a, 1), readInt(a, 1.5));
  const v: number[] = [0, 0];
  writeInt(v, 1, 5); writeInt(v, -3, 6); writeInt(v, 0.25, 7);
  console.log(v.join(","), v.length, (v as any)["-3"], (v as any)["0.25"]);
  // any receiver (the dynamic path)
  const b: any = [10, 20, 30];
  const hk: any = 1.5, nk: any = -1, bk: any = 4294967295, nnk: any = NaN;
  console.log(b[hk], b[nk], b[bk], b[nnk], b[1], b[-0]);
  b[hk] = "h"; b[nk] = "n"; b[bk] = "big"; b[nnk] = "nan"; b[4294967294] = "last";
  console.log(b.length, b[hk], b[nk], b[bk], b[nnk], b["1.5"], b[4294967294], Object.keys(b).length);
  // sparse arrays
  const sp: number[] = [];
  sp[1000000] = 1;
  sp[h] = 2;
  console.log(sp.length, sp[1000000], sp[h], sp[neg], sp[1e6 + 0.5]);
}
main();
