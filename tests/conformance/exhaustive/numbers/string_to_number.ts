// String to number: ToNumber (Number(s), +s, arithmetic), parseFloat and
// parseInt, as V8 computes them. The runtime trimmed only ASCII whitespace,
// accepted C's forms ("inf", a signed "0x10"), parsed parseInt through
// strtol (saturating at 2^63, no ToString of a non-string argument, the
// radix read as raw bits) and parseFloat through strtod ("0x10" read as 16).

const ws = "         　﻿\t\v\f\r\n ";
const ins: any[] = [1e21, 0.0000005, -0, 12.7, "  42abc", "  7", "\v9", "123456789012345678901234567890",
  "-0", "0x1f", "1e3", "inf", "Infinity", "-Infinity", "0x10", ".5", "5.", "+.5e1", true, null, undefined,
  { toString() { return "33"; } }, [7, 8], "  11", ws + "12" + ws, "-00", "+", "-", "0x", "00x1",
  "1e", "1e+", ".e1", "-.5", "Infinityx", "+Infinity", "infinity", "1_000", "0b101", "0o17", "-0b1"];
const radices: any[] = [undefined, 16, "16", 2, 37, 1, -1, NaN, 4294967312, 0.9, "z", 36, 10, "0x10"];
function show(v: number): string { return Object.is(v, -0) ? "-0" : String(v); }
for (const x of ins) {
  console.log(JSON.stringify(typeof x === "string" ? x : String(x)), show(Number(x)), show(parseFloat(x)),
    radices.map((r) => show(parseInt(x, r))).join(","));
}

// Long digit strings in every radix: the power-of-two radixes round once to
// the nearest double (ties to even), radix 10 reads up to 310 digits
// correctly rounded, the others fold 32-bit parts.
let seed = 4242;
function rnd(): number { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
let h = 0;
function mix(s: string): void { for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 1000000007; }
for (let radix = 2; radix <= 36; radix++) {
  for (let i = 0; i < 60; i++) {
    const len = 1 + Math.floor(rnd() * 45);
    let s = "";
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * radix)];
    if (rnd() < 0.3) s = s.toUpperCase();
    if (rnd() < 0.2) s = "000" + s;
    if (rnd() < 0.2) s += "!junk";
    mix(show(parseInt(s, radix)));
    if (rnd() < 0.3) mix(show(parseInt("-" + s, radix)));
  }
}
console.log("parseInt radices", h);
h = 0;
for (let i = 0; i < 1500; i++) {
  const len = 1 + Math.floor(rnd() * 30);
  let s = "";
  for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * 10)];
  const dot = Math.floor(rnd() * (len + 1));
  if (rnd() < 0.6) s = s.slice(0, dot) + "." + s.slice(dot);
  if (rnd() < 0.4) s += (rnd() < 0.5 ? "e" : "E") + (rnd() < 0.5 ? "-" : "+") + Math.floor(rnd() * 330);
  if (rnd() < 0.2) s = "-" + s;
  mix(show(Number(s)) + "/" + show(parseFloat(s)) + "/" + show(parseFloat(s + "xyz")) + "/" + show(+(" " + s + "\n")));
}
console.log("decimal", h);
h = 0;
for (let i = 0; i < 900; i++) {
  const which = i % 3;
  const radix = which === 0 ? 16 : which === 1 ? 8 : 2;
  const prefix = which === 0 ? "0x" : which === 1 ? "0o" : "0b";
  const len = 1 + Math.floor(rnd() * 80);
  let s = "";
  for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * radix)];
  mix(show(Number(prefix + s)) + "/" + show(Number(prefix.toUpperCase() + s + " ")) + "/" + show(parseInt(s, radix)));
}
console.log("prefixed", h);
