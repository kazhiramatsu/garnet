// node:util: format's directives, inspect, promisify and callbackify, isDeepStrictEqual, the type predicates.
import util, { format, inspect, promisify, callbackify, isDeepStrictEqual, types, inherits } from "node:util";
function cb(x: number, callback: (err: Error | null, v?: number) => void): void { if (x < 0) callback(new Error("neg")); else callback(null, x * 2); }
async function main(): Promise<void> {
  const out: string[] = [];
  out.push([format("%s=%d %i %f %j %o %O %% %c", "n", 42.5, "7.9", "1.5", { a: [1] }, { o: 1 }, { b: 2 }, "css"), format("a", "b", 3, { c: true }), format("%s", null), format("%d", "x"), format("%s %s", "one"), format(1, 2), format("%j", undefined)].join("|"));
  out.push([inspect("it's"), inspect('say "hi"'), inspect("a\nb"), inspect({ a: 1, b: "s", c: [1, 2, { d: null }] }), inspect(new Map([["k", 1]])), inspect(new Set([1, "two"])), inspect(undefined), inspect(-0), inspect([undefined, null]), inspect(true)].join("|"));
  const twice = promisify(cb);
  const r1 = await twice(21);
  let r2 = "";
  try { await twice(-1); } catch (e) { r2 = (e as Error).message; }
  const back = callbackify(async (x: number) => x + 1);
  const r3 = await new Promise<string>((res) => { back(1, (err: unknown, v?: number) => { res(String(err) + ":" + v); }); });
  out.push([r1, r2, r3].join("|"));
  out.push([isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), isDeepStrictEqual([1], ["1"]), isDeepStrictEqual(NaN, NaN), isDeepStrictEqual(0, -0), isDeepStrictEqual(new Set([1, 2]), new Set([2, 1])), isDeepStrictEqual(new Map([["a", { x: 1 }]]), new Map([["a", { x: 1 }]])), isDeepStrictEqual(new Date(5), new Date(5)), isDeepStrictEqual(/a/g, /a/g), isDeepStrictEqual(/a/g, /a/i), isDeepStrictEqual({ a: 1 }, { a: 1, b: undefined })].join("|"));
  out.push([types.isDate(new Date()), types.isRegExp(/x/), types.isRegExp("x"), types.isPromise(Promise.resolve()), types.isMap(new Map()), types.isSet(new Set()), types.isUint8Array(new Uint8Array(1)), types.isTypedArray(new Float64Array(1)), types.isNativeError(new TypeError("t")), types.isArrayBuffer(new ArrayBuffer(1))].join("|"));
  out.push([typeof util.inspect, typeof util.types.isDate, util.format === format].join("|"));
  function Parent(this: { kind: string }): void { this.kind = "parent"; }
  Parent.prototype.hello = function (this: { kind: string }): string { return "hi " + this.kind; };
  function Child(this: { kind: string }): void { this.kind = "child"; }
  inherits(Child, Parent);
  const c = new (Child as unknown as new () => { kind: string; hello(): string })();
  out.push([c.hello(), c instanceof (Parent as unknown as new () => unknown), (Child as unknown as { super_: unknown }).super_ === Parent].join("|"));
  console.log(out.join("\n"));
}
main();
