// Number.prototype.toString(radix), toFixed and toPrecision as the spec and
// V8 define them. toString(radix) crashed on magnitudes past 2^53 (its digit
// arithmetic left the alphabet); toPrecision rounded exact ties to even
// ((2.5).toPrecision(1) printed "2"); the arguments were read as raw bits
// (a string radix meant 10) and out-of-range ones were clamped instead of
// throwing RangeError.

const xs = [0, -0, 1, -1, 0.5, 1.005, 2.5, -2.5, 1e21, 1.23e-10, 123.456, 0.000001, 255, -255, 1e100,
  123456789.123456789, 5e-324, 1.7976931348623157e308, NaN, Infinity, 0.1, 1 / 3, 0.125, 3.5, -0.0001];
for (const x of xs) {
  console.log([x.toFixed(0), x.toFixed(2), x.toFixed(10), x.toPrecision(1), x.toPrecision(2), x.toPrecision(5),
    x.toPrecision(21), x.toString(2), x.toString(16), x.toString(36), x.toString(7), x.toString(3)].join(" "));
}

const errs: string[] = [];
for (const f of [() => (1).toPrecision(0), () => (1).toPrecision(101), () => (1).toFixed(101),
  () => (NaN).toFixed(101), () => (1).toFixed(-1), () => (1).toString(1), () => (1).toString(37),
  () => (255).toString(Infinity), () => (NaN).toPrecision(0), () => (1).toPrecision(100).length]) {
  try { errs.push(String(f())); } catch (e) { errs.push((e as Error).constructor.name); }
}
console.log(errs.join(" "));

const anyArg: any = "16", digits: any = "2", prec: any = { valueOf() { return 4; } }, undef: any = undefined;
console.log((255).toString(anyArg), (255).toFixed(digits), (255).toPrecision(prec), (255).toString(undef),
  (1.5).toFixed(undef), (1.5).toPrecision(undef), (255).toString(36.9), (2.5).toFixed(0.9));

// sweeps hashed: random doubles over many magnitudes in every radix,
// toPrecision 1..21 and toFixed 0..20
let seed = 777;
function rnd(): number { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
let h = 0;
function mix(s: string): void { for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 1000000007; }
for (let i = 0; i < 600; i++) {
  const x = (rnd() < 0.5 ? -1 : 1) * rnd() * Math.pow(10, Math.floor(rnd() * 60) - 20);
  for (let radix = 2; radix <= 36; radix += 1 + Math.floor(rnd() * 5)) mix(x.toString(radix));
  mix(x.toPrecision(1 + Math.floor(rnd() * 21)));
  if (Math.abs(x) < 1e21) mix(x.toFixed(Math.floor(rnd() * 21)));
}
console.log("sweep", h);
