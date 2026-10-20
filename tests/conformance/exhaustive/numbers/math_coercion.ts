// Math converts its arguments with ToNumber: numeric strings, booleans and
// null become numbers and objects go through valueOf, in argument order and
// after the whole argument list is evaluated. The direct calls, spread calls
// and the Math functions taken as values used to reinterpret a boxed
// non-number as NaN. Math.hypot follows V8's algorithm to the last bit.

const log: string[] = [];
function v(n: number, tag: string): any { return { valueOf() { log.push(tag); return n; } }; }
const anyArgs: any[] = [v(3, "a"), "7", true, null, v(NaN, "b"), v(9, "c")];
const a0: any = anyArgs[0], a1: any = anyArgs[1], a2: any = anyArgs[2];

console.log("direct", Math.max(a0, a1), Math.min(a1, a2), Math.abs(a1), Math.pow(a1, a2),
  Math.hypot(a0, a1), Math.sqrt(a1), Math.floor("4.5" as any), Math.clz32("12" as any),
  Math.round(" 2.5 " as any), Math.sign("-3" as any), Math.atan2(a2, "1" as any));
console.log("log1", log.join(","));
log.length = 0;

// Every argument is evaluated before the first conversion.
console.log("order", Math.max(v(1, "x"), (log.push("eval-2"), 2), v(3, "z")),
  Math.pow(v(2, "p"), v(10, "q")), Math.min(v(5, "m"), (log.push("eval-n"), 4)));
console.log("log2", log.join(","));
log.length = 0;

console.log("spread", Math.max(...anyArgs), Math.min(...anyArgs), Math.hypot(...[NaN, Infinity]),
  Math.hypot(...anyArgs.slice(0, 4)), Math.max(...(["3", "11", "2"] as any[])));
console.log("log3", log.join(","));
log.length = 0;

const fns: any[] = [Math.max, Math.min, Math.abs, Math.round, Math.trunc, Math.sign, Math.atan2,
  Math.pow, Math.imul, Math.clz32, Math.cbrt, Math.hypot];
console.log("values", fns.map((f) => String(f("12", v(2, "d")))).join(" "));
console.log("log4", log.join(","));

console.log("edges", Math.hypot(NaN, Infinity), Math.hypot(-Infinity, NaN), Math.hypot(),
  Math.hypot(-0), Math.hypot(1e200, 1e200), Math.hypot(1e300, 1e300, 1e300), Math.hypot(3, 4, 12),
  Math.max(), Math.min(), Math.max(-0, 0), Math.min(0, -0));

// hypot of 1 to 4 values over magnitudes 1e-3 .. 1e15 and 1e21 .. 1e40
let seed = 12345;
function rnd(): number { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function val(): number {
  const r = rnd();
  const big = rnd() < 0.25;
  const e = big ? 21 + Math.floor(rnd() * 20) : Math.floor(rnd() * 18) - 3;
  const s = rnd() < 0.5 ? -1 : 1;
  if (r < 0.02) return 0;
  return s * (1 + r) * Math.pow(10, e);
}
let h = 0;
const sample: string[] = [];
for (let i = 0; i < 4000; i++) {
  const a = val(), b = val(), c = val(), d = val();
  const s = [Math.hypot(a), Math.hypot(a, b), Math.hypot(a, b, c), Math.hypot(a, b, c, d)].map(String).join(",");
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 1000000007;
  if (i % 1000 === 0) sample.push(s);
}
console.log("hypot", h, sample.join(" | "));
