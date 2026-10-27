// The arguments object as a value: passed on (`apply(this, arguments)`), indexed, counted, copied and
// iterated, in function declarations, function expressions, object-literal methods and class methods,
// with more and with fewer actual arguments than parameters (strict code: the object is unmapped).
function sum(_a?: number, _b?: number, _c?: number): number {
  let t = 0;
  for (let i = 0; i < arguments.length; i++) t += arguments[i] as number;
  return t;
}
function forward(this: unknown, a: number, b: number): string {
  return `${a},${b}:` + sum.apply(null, arguments as unknown as number[]) + ":" + arguments.length;
}
function describe(first: string, second?: string): string {
  const copy = Array.from(arguments as unknown as ArrayLike<string>);
  const spread = [...(arguments as unknown as string[])];
  return `${first}/${second}/${copy.join("+")}/${spread.length}/${typeof arguments}`;
}
const expr = function (x: number): number[] {
  const out: number[] = [];
  for (const v of arguments as unknown as Iterable<number>) out.push(v * x);
  return out;
};
const methods = {
  every(fn: (item: number) => boolean, thisArg?: unknown): string {
    return apply("every", fn, thisArg, arguments);
  },
  slice(): number[] { return Array.prototype.slice.call(arguments, 1) as number[]; },
};
function apply(method: string, fn: (item: number) => boolean, thisArg: unknown, args: IArguments): string {
  return `${method}:${args.length}:${typeof args[0]}:${args[1]}:${fn(3)}:${thisArg}`;
}
class Logger {
  lines: string[] = [];
  log(level: string, _a?: unknown, _b?: unknown, _c?: unknown): void {
    const rest: unknown[] = [];
    for (let i = 1; i < arguments.length; i++) rest.push(arguments[i]);
    this.lines.push(level + "=" + rest.join("|"));
  }
  count(a?: number, b?: number, c?: number): number { return arguments.length * 10 + (a ?? 0) + (b ?? 0) + (c ?? 0); }
}
function main(): void {
  console.log(sum(), sum(1), sum(1, 2, 3), sum(0.5, 0.25));
  console.log(forward(1, 2), forward.call(null, 3, 4), (forward as any)(5, 6, 7, 8));
  console.log(describe("a"), describe("a", "b"), (describe as any)("a", "b", "c"));
  console.log(expr(2).join(","), (expr as any)(2, 3, 4).join(","));
  console.log(methods.every((v) => v > 2, "ctx"), methods.every((v) => v > 5));
  console.log(methods.slice(), (methods.slice as any)(9, 8, 7));
  const lg = new Logger();
  lg.log("info"); lg.log("warn", 1, "two", null); (lg.log as any)("err", true);
  console.log(lg.lines.join(" "), lg.count(), lg.count(1), lg.count(1, 2), lg.count(1, 2, 3), (lg.count as any)(1, 2, 3, 4));
}
main();
