// `x === n` and `x !== n` with one side an unboxed number and the other a
// boxed value: numbers of every origin, NaN on either side, -0 against 0,
// strings that look like numbers, booleans, null, undefined, objects, and
// the comparison used as a value, in conditions and in loops.
function boxed(i: number): unknown {
  switch (i % 9) {
    case 0: return 1;
    case 1: return "1";
    case 2: return NaN;
    case 3: return -0;
    case 4: return true;
    case 5: return null;
    case 6: return undefined;
    case 7: return { valueOf: () => 1 };
    default: return 1.0000000000000002;
  }
}
function main() {
  const out: unknown[] = [];
  const one = 1;
  let zero = 0;
  let nan = NaN;
  for (let i = 0; i < 9; i++) {
    const x = boxed(i);
    out.push([x === one, x !== one, x === zero, x === -zero, x === nan, x !== nan, one === x, zero === x]);
  }
  const arr: (number | undefined)[] = [3, undefined, 3.5, -0, NaN];
  let hits = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    const three = 3;
    if (v === three) hits += 1;
    if (v !== three) hits += 10;
    if (v === 0) hits += 100;
    if (v === NaN) hits += 1000;
  }
  out.push(hits);
  const m = new Map<string, number>([["a", 1], ["b", 2]]);
  const got = m.get("a");
  const want = 1;
  out.push(got === want, m.get("zz") === want, m.get("b") !== want);
  let k = 0;
  let n: any = 0;
  while (n === k && k < 5) { k++; n = k < 3 ? k : "" + k; }
  out.push(k, n);
  const big = 2 ** 53;
  const bigBoxed: unknown = 2 ** 53 + 1;
  out.push(bigBoxed === big, (0.1 + 0.2) === 0.3, (0.1 + 0.2 as unknown) === 0.30000000000000004);
  console.log(JSON.stringify(out));
}
main();
