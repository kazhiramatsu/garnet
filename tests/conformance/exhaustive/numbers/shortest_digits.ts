// Number.prototype.toString chooses the shortest digit string that reads back as the number.
// At a power of two the rounding interval is asymmetric (the gap below is half the gap above),
// so the correctly rounded k-digit decimal can fall outside it while its neighbour is inside:
// 2 ** -24 is 5.960464477539063e-8 (16 digits), not the 17-digit exact expansion. Every power
// of two, a hash of the strings of pseudo-random doubles across the exponent range, and the
// classic cases, through String, template literals and JSON.stringify.
class Rng {
  private state: number;
  constructor(seed: number) { this.state = seed | 0; }
  next(): number {
    this.state = (this.state + 0x6D2B79F5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
function hashOf(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
function main(): void {
  const twos: string[] = [];
  let p = 1;
  for (let k = 0; k <= 1023; k++) { twos.push(String(p)); p *= 2; }
  let q = 1;
  for (let k = 1; k <= 1074; k++) { q /= 2; twos.push(`${q}`); }
  console.log(twos.join(" "));
  // the three forms agree
  console.log(String(2 ** -24), `${2 ** -24}`, JSON.stringify(2 ** -24), (2 ** -24).toString(), JSON.stringify([2 ** -1074, 2 ** 1023, 2 ** -1022]));
  // pseudo-random doubles across the exponent range, and near powers of two
  const rng = new Rng(77);
  let h = 0;
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  for (let i = 0; i < 20000; i++) {
    u32[0] = (rng.next() * 4294967296) >>> 0;
    u32[1] = (rng.next() * 4294967296) >>> 0;
    const x = f64[0];
    if (x !== x || x === Infinity || x === -Infinity) continue;
    h = hashOf(h, String(x));
  }
  console.log(h);
  let h2 = 0;
  for (let i = 0; i < 20000; i++) {
    const e = Math.floor(rng.next() * 2000) - 1000;
    const m = 1 + Math.floor(rng.next() * 8) * 2.220446049250313e-16;   // 1 + a few ulps
    const x = m * Math.pow(2, e);
    h2 = hashOf(h2, String(x) + String(-x) + String(x * 3) + String(x / 3));
  }
  console.log(h2);
  console.log(0.1 + 0.2, 1 / 3, 2 / 3, 1e21, 1e-7, 123456789012345680000, 9007199254740993, 5e-324, 1.7976931348623157e308, 4.35, 0.000001, 1e-6 / 10, 100 / 3, 1.5e-10, 2 ** 53 + 2, 25 ** 0.5 * 1e22, 1.1 ** 10);
}
main();
