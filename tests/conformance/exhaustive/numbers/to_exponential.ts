// Number.prototype.toExponential: the shortest digits without an argument,
// f fraction digits rounded half up on the exact value, the argument's
// conversion and range, non-finite receivers, and any-typed receivers.
function report(label: string, f: () => unknown): void {
  try { console.log(label, f()); }
  catch (e) { console.log(label, "threw", (e as Error).constructor.name, (e as Error).message); }
}
const xs = [0, -0, 1, -1, 123.456, 0.000123, 1.5e-7, 1e21, 12345678901234567000, 5e-324,
  1.7976931348623157e308, 0.1, 0.5, 2.5, 1.25, -1.005, 100, 1e-6, 9.95, 99.5];
for (const x of xs) {
  console.log(String(x), x.toExponential(), x.toExponential(0), x.toExponential(1), x.toExponential(2), x.toExponential(5));
}
console.log((123.456).toExponential(20), (0.1).toExponential(25), (2 ** 60).toExponential(18));
console.log((1e21).toExponential(100).length, (5e-324).toExponential(100).slice(0, 30));
report("NaN", () => [NaN.toExponential(), NaN.toExponential(2), NaN.toExponential(200)].join());
report("Infinity", () => [Infinity.toExponential(), (-Infinity).toExponential(3)].join());
report("negative digits", () => (1).toExponential(-1));
report("too many digits", () => (1).toExponential(101));
report("fractional digits", () => (1.23456).toExponential(2.9));
const anyArg: any = "3";
report("string digits", () => (9.87654).toExponential(anyArg));
report("NaN digits", () => (9.87654).toExponential(NaN));
report("undefined digits", () => (9.87654).toExponential(undefined));
const anyNum: any = 4321.5;
report("any receiver", () => [anyNum.toExponential(), anyNum.toExponential(1)].join());
const method: any = (0).toExponential;
report("method value", () => method.call(12.5, 1));
