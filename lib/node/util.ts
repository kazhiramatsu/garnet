import { host } from "./host";
// node:util: format and inspect over the runtime's console formatter, promisify
// and callbackify, inherits, deprecate, debuglog, the type predicates and the
// legacy is* functions.
import { invalidArgType } from "./errors";
import { isDeepEqual, isRegExpValue } from "./internal/comparisons";
import { inspectValue } from "./internal/inspect";
import process from "./process";

export interface InspectOptions { depth?: number | null; colors?: boolean; compact?: boolean | number; breakLength?: number; showHidden?: boolean; sorted?: boolean; getters?: boolean }
/** The text console.log would print for the value (a string quoted, as util.inspect does). */
export function inspect(value: unknown, _options?: InspectOptions): string { return inspectValue(value); }
function formatValue(v: unknown): string { return typeof v === "string" ? v : inspect(v); }
function formatNumber(v: unknown): string {
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "object" && v !== null) return "NaN";
  if (typeof v === "symbol") return "NaN";
  return String(Number(v));
}
export function format(f?: unknown, ...args: unknown[]): string {
  if (typeof f !== "string") {
    const parts: string[] = [];
    if (f !== undefined || args.length > 0) parts.push(inspect(f));
    for (const a of args) parts.push(inspect(a));
    return parts.join(" ");
  }
  let out = "";
  let argi = 0;
  let last = 0;
  for (let i = 0; i < f.length - 1; i++) {
    if (f.charCodeAt(i) !== 37) continue; // %
    const next = f.charCodeAt(i + 1);
    if (next === 37) { out += f.slice(last, i) + "%"; last = i + 2; i++; continue; }
    if (argi >= args.length) continue;
    let piece: string | undefined = undefined;
    const arg = args[argi];
    switch (next) {
      case 115: piece = typeof arg === "string" ? arg : (typeof arg === "object" && arg !== null && !(arg instanceof Error)) ? inspect(arg) : String(arg); break; // s
      case 100: piece = formatNumber(arg); break; // d
      case 105: piece = typeof arg === "object" && arg !== null ? "NaN" : String(parseInt(String(arg), 10)); break; // i
      case 102: piece = typeof arg === "symbol" ? "NaN" : String(parseFloat(String(arg))); break; // f
      case 106: { // j
        try { piece = JSON.stringify(arg); if (piece === undefined) piece = "undefined"; }
        catch (e) { if (e instanceof TypeError && e.message.includes("circular")) piece = "[Circular]"; else throw e; }
        break;
      }
      case 111: case 79: piece = inspect(arg); break; // o O (%o shows no hidden properties here)
      case 99: piece = ""; break; // c
      default: continue;
    }
    out += f.slice(last, i) + piece;
    last = i + 2;
    i++;
    argi++;
  }
  out += f.slice(last);
  for (; argi < args.length; argi++) out += " " + formatValue(args[argi]);
  return out;
}
export function formatWithOptions(_options: InspectOptions, f?: unknown, ...args: unknown[]): string { return format(f, ...args); }

const kCustomPromisified: unique symbol = Symbol.for("nodejs.util.promisify.custom") as unknown as typeof kCustomPromisified;
function promisifyImpl<T>(fn: (...args: any[]) => void): (...args: any[]) => Promise<T> {
  if (typeof fn !== "function") throw invalidArgType("original", "of type function", fn);
  const custom = (fn as unknown as { [key: symbol]: unknown })[kCustomPromisified];
  if (typeof custom === "function") return custom as (...args: any[]) => Promise<T>;
  return function (this: unknown, ...args: any[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      fn.call(this, ...args, (err: unknown, ...values: unknown[]) => {
        if (err) reject(err);
        else resolve((values.length > 1 ? values : values[0]) as T);
      });
    });
  };
}
/** promisify(fn), and promisify.custom: the symbol under which a function offers its own promise form. */
export const promisify: typeof promisifyImpl & { custom: typeof kCustomPromisified } = promisifyImpl as typeof promisifyImpl & { custom: typeof kCustomPromisified };
promisify.custom = kCustomPromisified;
export function callbackify(fn: (...args: any[]) => Promise<unknown>): (...args: any[]) => void {
  if (typeof fn !== "function") throw invalidArgType("original", "of type function", fn);
  return function (this: unknown, ...args: any[]): void {
    const cb = args.pop() as (err: unknown, value?: unknown) => void;
    if (typeof cb !== "function") throw invalidArgType("last argument", "of type function", cb);
    fn.apply(this, args).then(
      (value) => { Promise.resolve().then(() => cb(null, value)); },
      (reason) => { Promise.resolve().then(() => cb(reason === null || reason === undefined ? new Error("Promise was rejected with a falsy value") : reason)); });
  };
}
export function inherits(ctor: Function & { super_?: unknown }, superCtor: Function): void {
  if (typeof ctor !== "function") throw invalidArgType("ctor", "of type function", ctor);
  if (typeof superCtor !== "function") throw invalidArgType("superCtor", "of type function", superCtor);
  ctor.super_ = superCtor;
  host.relink(ctor.prototype as object, superCtor.prototype as object);   // a garnet class's prototype is refused (a TypeError)
}
const deprecations = new Set<string>();
export function deprecate<F extends (...args: any[]) => any>(fn: F, msg: string, code?: string): F {
  let warned = false;
  const wrapped = function (this: unknown, ...args: any[]): any {
    if (!warned) {
      warned = true;
      if (code === undefined || !deprecations.has(code)) {
        if (code !== undefined) deprecations.add(code);
        process.emitWarning(msg, "DeprecationWarning", code);
      }
    }
    return fn.apply(this, args);
  };
  return wrapped as unknown as F;
}
export function debuglog(section: string): (...args: unknown[]) => void {
  const env = process.env.NODE_DEBUG;
  const upper = section.toUpperCase();
  const enabled = env !== undefined && env.split(",").some((s) => s.trim().toUpperCase() === upper || s.trim() === "*");
  if (!enabled) return () => {};
  return (...args: unknown[]) => { process.stderr.write(upper + " " + process.pid + ": " + format(...args) + "\n"); };
}
export function isDeepStrictEqual(a: unknown, b: unknown): boolean { return isDeepEqual(a, b, true); }
export function stripVTControlCharacters(s: string): string {
  return s.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g, "");
}
export const types = {
  isDate(v: unknown): v is Date { return v instanceof Date; },
  isRegExp(v: unknown): v is RegExp { return isRegExpValue(v); },
  isPromise(v: unknown): v is Promise<unknown> { return v instanceof Promise; },
  isMap(v: unknown): v is Map<unknown, unknown> { return v instanceof Map; },
  isSet(v: unknown): v is Set<unknown> { return v instanceof Set; },
  isWeakMap(v: unknown): v is WeakMap<object, unknown> { return v instanceof WeakMap; },
  isWeakSet(v: unknown): v is WeakSet<object> { return v instanceof WeakSet; },
  isArrayBuffer(v: unknown): v is ArrayBuffer { return v instanceof ArrayBuffer; },
  isAnyArrayBuffer(v: unknown): v is ArrayBuffer { return v instanceof ArrayBuffer || v instanceof SharedArrayBuffer; },
  isTypedArray(v: unknown): boolean { return ArrayBuffer.isView(v); },   // garnet has no DataView
  isUint8Array(v: unknown): v is Uint8Array { return v instanceof Uint8Array; },
  isArrayBufferView(v: unknown): boolean { return ArrayBuffer.isView(v); },
  isNativeError(v: unknown): v is Error { return v instanceof Error; },
  isBoxedPrimitive(_v: unknown): boolean { return false; },
  isProxy(_v: unknown): boolean { return false; },
  isAsyncFunction(v: unknown): boolean { return typeof v === "function" && (v as { constructor: { name: string } }).constructor.name === "AsyncFunction"; },
  isGeneratorFunction(v: unknown): boolean { return typeof v === "function" && (v as { constructor: { name: string } }).constructor.name === "GeneratorFunction"; },
  isGeneratorObject(v: unknown): boolean { return typeof v === "object" && v !== null && typeof (v as { next?: unknown }).next === "function" && typeof (v as { throw?: unknown }).throw === "function"; },
};
const util = { inspect, format, formatWithOptions, promisify, callbackify, inherits, deprecate, debuglog, isDeepStrictEqual,
  stripVTControlCharacters, types };
export default util;
