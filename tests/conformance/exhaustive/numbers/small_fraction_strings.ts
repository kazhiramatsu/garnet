// Number to string for magnitudes in [1e-6, 1e-4): JS writes them in
// decimal with all the significant digits of the shortest round trip
// ("0.000004391539096832276"); the runtime dropped the digits past the
// twentieth decimal place, a different number.

const xs: number[] = [4.391539096832276e-6, 1.2345678901234567e-6, 9.876543210987654e-5,
  1e-6, 1.1e-6, 1.0000000000000002e-6, 9.999999999999999e-7, 0.00001, 0.000012345678901234568,
  -2.5e-6, -1.7976931348623157e-5, 5.551115123125783e-6, 0.0001, 0.00009999999999999999];
console.log(xs.map(String).join(" "));
console.log(xs.map((x) => "" + x).join(" "));
console.log(xs.map((x) => `${x}`).join(" "));
console.log(JSON.stringify(xs));
console.log(xs.map((x) => x.toString()).join(" "));

// a sweep with a round-trip check: every printed number parses back to itself
let seed = 99;
function rnd(): number { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
let bad = 0, h = 0;
for (let i = 0; i < 5000; i++) {
  const e = -7 + Math.floor(rnd() * 4);       // 1e-7 .. 1e-4
  const x = (1 + rnd() * 9) * Math.pow(10, e) * (rnd() < 0.5 ? -1 : 1);
  const s = String(x);
  if (Number(s) !== x) bad++;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 1000000007;
}
console.log("round-trip failures", bad, "hash", h);
