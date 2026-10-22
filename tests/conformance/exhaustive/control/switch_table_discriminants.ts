// A numeric switch emitted as a C jump table (docs/switch_chain_design.md)
// switches on the discriminant's ToInt32 and sends every number that is not
// exactly that integer to the default: fractions, NaN, the infinities, values
// outside int32 and those equal to a case modulo 2^32. -0 matches case 0
// (`-0 === 0`), and a case at INT32_MIN still matches.
function kind(x: number): string {
  switch (x) {
    case 0: return "zero";
    case 1: return "one";
    case 2: return "two";
    case 7: return "seven";
    case -1: return "minus one";
    case 261: return "261";
    default: return "default";
  }
}
function extremes(x: number): string {
  switch (x) {
    case -2147483648: return "min";
    case 2147483647: return "max";
    case 5: return "five";
    case 6: return "six";
    default: return "other";
  }
}
function count(xs: number[]): number[] {
  const hits = [0, 0, 0, 0, 0];
  for (const x of xs) {
    switch (x) {
      case 10: hits[0]++; break;
      case 20: hits[1]++; break;
      case 30: hits[2]++; break;
      case 40: hits[3]++; break;
      default: hits[4]++;
    }
  }
  return hits;
}
const probes = [0, -0, 1, 2, 7, -1, 261, 261.5, 0.5, -0.5, NaN, Infinity, -Infinity,
  4294967296, 4294967297, 4294967296 + 261, -4294967296 + 7, 2147483648, -2147483649,
  1e300, 5e-324, -5e-324, 2 ** 53 + 2, 7.000000000000001];
for (const p of probes) console.log(String(p), Object.is(p, -0) ? "(-0)" : "", kind(p));
const probes2 = [-2147483648, 2147483647, -2147483647, 2147483648, -2147483649, 5, 6,
  5.0000001, 4294967301, -2147483648.5, NaN];
for (const p of probes2) console.log(String(p), extremes(p));
const xs: number[] = [];
for (let i = 0; i < 1000; i++) xs.push(i % 50, (i % 5) * 10 + 0.25, i % 3 === 0 ? NaN : 20);
console.log(count(xs).join(","));
