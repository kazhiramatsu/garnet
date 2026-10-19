// int32 locals for bitwise-only uses: a number read once and tested against
// constants with bitwise operators holds ToInt32 of its value from the
// definition on. Every value class must give the per-use result: integers,
// negatives, fractions, NaN, infinities, huge magnitudes, negative zero,
// copies between such locals, shifts with converted counts, `~`,
// reassignment in loops, conditional definitions, parameters, and a local
// that is also used outside bitwise operators (the unchanged path).
interface Flagged { flags: number; other: number; }
function classify(o: Flagged): string {
  const f = o.flags;
  let out = "";
  if (f & 1) out += "a";
  if (f & 2) out += "b";
  if (f & 0x80000000) out += "s";
  if ((f | 4) === 5) out += "c";
  out += (f >> 1) + "," + (f >>> 1) + "," + (f << 2) + "," + (~f) + "," + (f ^ 0xff) + ";";
  return out;
}
function mixed(o: Flagged): string {
  const f = o.flags;
  return (f & 1) + ":" + (f === 1.5 ? "frac" : "int") + ":" + (f > 2 ? "big" : "small");
}
function copies(o: Flagged): number {
  const a = o.flags;
  const b = a;
  let c = b;
  if (o.other > 0) c = o.other;
  return (a & 7) + (b | 8) + (c & 15);
}
function shifts(o: Flagged): number {
  const n = o.flags;
  const k = o.other;
  return (n << k) + (n >> k) + (n >>> k) + (1 << n);
}
function loopy(o: Flagged): number {
  let acc = o.flags;
  let t = 0;
  for (let i = 0; i < 5; i++) { t += acc & 3; acc = o.other + i * 1.5; }
  return t;
}
function param(f: number, g: number): number {
  return (f & 1) + (f >> 1) + (g | 0);
}
function chain(o: Flagged): number {
  const x = o.flags;
  const y = x & 0xffff;
  const z = y | 0x10000;
  return (z ^ 1) + (y >>> 0);
}
function viaCall(o: Flagged): number {
  const m = Math.floor(o.flags * 1.5);
  const s = o.flags + o.other;
  return (m & 0xff) + (s | 0);
}
function main(): void {
  const values = [0, 1, 3, 5, -1, -7, 2.5, -2.5, 0.999, NaN, Infinity, -Infinity, 2147483647, 2147483648, -2147483648, -2147483649, 4294967295, 4294967296, 4294967301, 1e20, -1e20, 9007199254740993, -0, 31, 32, 33, -33];
  const out: string[] = [];
  for (const v of values) {
    const o: Flagged = { flags: v, other: 3 };
    out.push(classify(o) + "|" + mixed(o) + "|" + copies(o) + "|" + copies({ flags: v, other: -1 }) + "|" + shifts({ flags: v, other: 3 }) + "|" + shifts({ flags: 5, other: v }) + "|" + loopy({ flags: v, other: v }) + "|" + param(v, v) + "|" + chain(o) + "|" + viaCall(o));
  }
  console.log(out.join("\n"));
  let total = 0;
  for (let i = 0; i < 100000; i++) {
    const o: Flagged = { flags: i * 7919.5, other: i };
    const f = o.flags;
    if (f & 8) total += 1;
    if (f & 0x40000) total += 2;
    total += (f >> 20) & 3;
  }
  console.log(total);
}
main();
