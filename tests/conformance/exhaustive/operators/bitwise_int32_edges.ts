// ToInt32 / ToUint32 fast path (exact int32 values in line) and slow path
// (NaN, infinities, fractions, values beyond 2^31 and 2^32, negative zero)
// through every bitwise operator and the unsigned shift; strict equality of
// numbers, objects, functions, strings, booleans and nullish values after the
// fast-path reordering.
function main(): void {
  const vals: number[] = [0, -0, 1, -1, 0.5, -0.5, 1.9, -1.9, 2147483647, 2147483648, -2147483648, -2147483649, 4294967295, 4294967296, 4294967297, 1e10, -1e10, 1e20, -1e20, NaN, Infinity, -Infinity, 123456789012.75, 7.000000001];
  const out: string[] = [];
  for (const v of vals) out.push((v | 0) + "," + (v & 0xff) + "," + (v ^ 1) + "," + (v >>> 0) + "," + (v >> 3) + "," + (v << 4) + "," + (~v));
  console.log(out.join(" "));
  let acc = 0;
  for (let i = 0; i < 20000; i++) acc = (acc + ((i * 2654435761) | 0)) & 0x7fffffff;
  console.log(acc, (2 ** 53) | 0, (2 ** 53 + 2) >>> 0, (-(2 ** 40) - 3) | 0, (1e15 + 0.5) & 0xffff);
  const o1 = { a: 1 }, o2 = { a: 1 };
  const f1 = () => 1, f2 = () => 1;
  const s1 = "same", s2 = "sa" + "me", s3 = "different length";
  const mixed: any[] = [o1, o2, f1, f2, s1, s2, s3, 1, 1.0, NaN, -0, 0, true, false, null, undefined, "1", [1], o1];
  const names = ["o1", "o2", "f1", "f2", "s1", "s2", "s3", "1", "1.0", "NaN", "-0", "0", "true", "false", "null", "undefined", "'1'", "[1]", "o1"];
  const eq: string[] = [];
  for (let i = 0; i < mixed.length; i++) for (let j = 0; j < mixed.length; j++) if (mixed[i] === mixed[j]) eq.push(names[i] + "=" + names[j]);
  console.log(eq.join(" "));
  let same = 0;
  const objs: { id: number }[] = [];
  for (let i = 0; i < 3000; i++) objs.push({ id: i });
  for (let round = 0; round < 3; round++) {
    const junk: any[] = [];
    for (let i = 0; i < 20000; i++) junk.push({ i });
    for (let i = 0; i < objs.length; i++) if (objs[i] === objs[(i * 7) % objs.length]) same++;
    if (junk.length !== 20000) same = -1;
  }
  console.log(same);
}
main();
