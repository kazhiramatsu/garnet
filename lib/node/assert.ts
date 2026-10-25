// node:assert: the assertions with Node's AssertionError (code ERR_ASSERTION, actual,
// expected, operator, generatedMessage); `strict` is the variant whose deep and loose
// forms compare strictly.
import { inspect } from "./util";
import { isDeepEqual, isRegExpValue } from "./internal/comparisons";

export interface AssertionErrorOptions { message?: string; actual?: unknown; expected?: unknown; operator?: string }
export class AssertionError extends Error {
  readonly code: string = "ERR_ASSERTION";
  actual: unknown;
  expected: unknown;
  operator: string | undefined;
  generatedMessage: boolean;
  constructor(options: AssertionErrorOptions) {
    super(options.message === undefined ? "Failed" : options.message);
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
    this.generatedMessage = options.message === undefined;
  }
}
function fail2(actual: unknown, expected: unknown, message: string | Error | undefined, operator: string, generated: string): never {
  if (message instanceof Error) throw message;
  const e = new AssertionError({ message: message === undefined ? generated : message, actual, expected, operator });
  e.generatedMessage = message === undefined;
  throw e;
}
/** Nothing was thrown or rejected: Node reports it with the message given (generatedMessage false). */
function missing(expected: unknown, message: string | Error | undefined, operator: string, generated: string): never {
  if (message instanceof Error) throw message;
  const e = new AssertionError({ message: message === undefined ? generated : message, actual: undefined, expected, operator });
  e.generatedMessage = false;
  throw e;
}
function compared(what: string, actual: unknown, expected: unknown, sign: string): string {
  return "Expected values to be " + what + ":\n\n" + inspect(actual) + " " + sign + " " + inspect(expected) + "\n";
}
export function fail(message?: string | Error): never {
  if (message instanceof Error) throw message;
  const e = new AssertionError({ message: message === undefined ? "Failed" : message, operator: "fail" });
  e.generatedMessage = message === undefined;
  throw e;
}
export function ok(value: unknown, message?: string | Error): asserts value {
  if (!value) fail2(value, true, message, "==", "The expression evaluated to a falsy value:\n\n  assert.ok(" + inspect(value) + ")\n");
}
export function equal(actual: unknown, expected: unknown, message?: string | Error): void {
  // eslint-disable-next-line eqeqeq
  if (!(actual == expected || (actual !== actual && expected !== expected))) fail2(actual, expected, message, "==", compared("loosely equal", actual, expected, "=="));
}
export function notEqual(actual: unknown, expected: unknown, message?: string | Error): void {
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (actual !== actual && expected !== expected)) fail2(actual, expected, message, "!=", "Expected \"actual\" to be loosely unequal to: " + inspect(expected));
}
export function strictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
  if (!Object.is(actual, expected)) fail2(actual, expected, message, "strictEqual", compared("strictly equal", actual, expected, "!=="));
}
export function notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
  if (Object.is(actual, expected)) fail2(actual, expected, message, "notStrictEqual", "Expected \"actual\" to be strictly unequal to: " + inspect(expected));
}
export function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void {
  if (!isDeepEqual(actual, expected, false)) fail2(actual, expected, message, "deepEqual", compared("loosely deep-equal", actual, expected, "!="));
}
export function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void {
  if (isDeepEqual(actual, expected, false)) fail2(actual, expected, message, "notDeepEqual", "Expected \"actual\" not to be loosely deep-equal to: " + inspect(expected));
}
export function deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
  if (!isDeepEqual(actual, expected, true)) fail2(actual, expected, message, "deepStrictEqual", compared("strictly deep-equal", actual, expected, "!=="));
}
export function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
  if (isDeepEqual(actual, expected, true)) fail2(actual, expected, message, "notDeepStrictEqual", "Expected \"actual\" not to be strictly deep-equal to: " + inspect(expected));
}
type Expected = RegExp | ((e: unknown) => boolean) | { [key: string]: unknown } | (new (...args: any[]) => Error);
function isErrorClass(e: unknown): e is new (...args: any[]) => Error {
  return typeof e === "function" && (e === Error || (e as { prototype: unknown }).prototype instanceof Error);
}
/** Whether the thrown value satisfies `expected`; throws the assertion of a mismatch. */
function checkThrown(thrown: unknown, expected: Expected | undefined, message: string | Error | undefined, fnName: string): void {
  if (expected === undefined) return;
  if (isRegExpValue(expected)) {
    const text = String(thrown);
    if (!expected.test(text)) fail2(thrown, expected, message, fnName, "The input did not match the regular expression " + inspect(expected) + ". Input:\n\n" + inspect(text) + "\n");
    return;
  }
  if (isErrorClass(expected)) {
    if (!(thrown instanceof expected)) {
      const received = thrown instanceof Error ? "\"" + thrown.name + "\"\n\nError message:\n\n" + thrown.message : inspect(thrown);
      fail2(thrown, expected, message, fnName, "The error is expected to be an instance of \"" + expected.name + "\". Received " + received);
    }
    return;
  }
  if (typeof expected === "function") {
    if ((expected as (e: unknown) => boolean)(thrown) !== true) fail2(thrown, expected, message, fnName, "The validation function is expected to return \"true\". Received false\n\nCaught error:\n\n" + inspect(thrown));
    return;
  }
  const obj = expected as { [key: string]: unknown };
  const got = thrown as { [key: string]: unknown };
  for (const key of Object.keys(obj)) {
    const want = obj[key];
    const have = thrown instanceof Error && (key === "message" || key === "name") ? (thrown as unknown as { [k: string]: unknown })[key] : got[key];
    if (isRegExpValue(want) && typeof have === "string") {
      if (!want.test(have)) fail2(thrown, expected, message, fnName, "The input did not match the regular expression " + inspect(want) + ". Input:\n\n" + inspect(have) + "\n");
    } else if (!isDeepEqual(have, want, true)) {
      fail2(thrown, expected, message, fnName, "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   " + key + ": " + inspect(have) + "\n-   " + key + ": " + inspect(want) + "\n  }\n");
    }
  }
}
export function throws(fn: () => unknown, expected?: Expected | string | Error, message?: string | Error): void {
  if (typeof fn !== "function") throw new TypeError("The \"fn\" argument must be of type function");
  let exp: Expected | undefined = undefined;
  if (typeof expected === "string") { message = expected; } else if (expected instanceof Error && !isErrorClass(expected)) { message = expected; } else exp = expected as Expected | undefined;
  let threw = false;
  let thrown: unknown = undefined;
  try { fn(); } catch (e) { threw = true; thrown = e; }
  if (!threw) {
    let detail = "";
    if (isErrorClass(exp)) detail = " (" + exp.name + ")";
    missing(exp, message, "throws", "Missing expected exception" + detail + ".");
  }
  checkThrown(thrown, exp, message, "throws");
}
export function doesNotThrow(fn: () => unknown, expected?: Expected | string | Error, message?: string | Error): void {
  if (typeof expected === "string") message = expected;
  try { fn(); }
  catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    fail2(e, expected, message, "doesNotThrow", "Got unwanted exception.\nActual message: \"" + detail + "\"");
  }
}
export async function rejects(promiseOrFn: Promise<unknown> | (() => Promise<unknown>), expected?: Expected | string | Error, message?: string | Error): Promise<void> {
  let exp: Expected | undefined = undefined;
  if (typeof expected === "string") { message = expected; } else if (expected instanceof Error && !isErrorClass(expected)) { message = expected; } else exp = expected as Expected | undefined;
  const p = typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn;
  let rejected = false;
  let reason: unknown = undefined;
  try { await p; } catch (e) { rejected = true; reason = e; }
  if (!rejected) {
    let detail = "";
    if (isErrorClass(exp)) detail = " (" + exp.name + ")";
    missing(exp, message, "rejects", "Missing expected rejection" + detail + ".");
  }
  checkThrown(reason, exp, message, "rejects");
}
export async function doesNotReject(promiseOrFn: Promise<unknown> | (() => Promise<unknown>), expected?: Expected | string | Error, message?: string | Error): Promise<void> {
  if (typeof expected === "string") message = expected;
  const p = typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn;
  try { await p; }
  catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    fail2(e, expected, message, "doesNotReject", "Got unwanted rejection.\nActual message: \"" + detail + "\"");
  }
}
export function match(value: string, regExp: RegExp, message?: string | Error): void {
  if (typeof value !== "string") fail2(value, regExp, message, "match", "The \"string\" argument must be of type string. Received type " + typeof value + " (" + inspect(value) + ")");
  if (!regExp.test(value)) fail2(value, regExp, message, "match", "The input did not match the regular expression " + inspect(regExp) + ". Input:\n\n" + inspect(value) + "\n");
}
export function doesNotMatch(value: string, regExp: RegExp, message?: string | Error): void {
  if (typeof value !== "string") fail2(value, regExp, message, "doesNotMatch", "The \"string\" argument must be of type string. Received type " + typeof value + " (" + inspect(value) + ")");
  if (regExp.test(value)) fail2(value, regExp, message, "doesNotMatch", "The input was expected to not match the regular expression " + inspect(regExp) + ". Input:\n\n" + inspect(value) + "\n");
}
export function ifError(value: unknown): void {
  if (value === null || value === undefined) return;
  let message = "ifError got unwanted exception: ";
  if (typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string") {
    const m = (value as { message: string }).message;
    message += m.length === 0 && (value as { constructor?: { name?: string } }).constructor ? (value as { constructor: { name: string } }).constructor.name : m;
  } else message += inspect(value);
  const e = new AssertionError({ message, actual: value, expected: null, operator: "ifError" });
  e.generatedMessage = false;
  throw e;
}
export interface Assert {
  (value: unknown, message?: string | Error): asserts value;
  AssertionError: typeof AssertionError;
  fail: typeof fail; ok: typeof ok; equal: typeof equal; notEqual: typeof notEqual; strictEqual: typeof strictEqual;
  notStrictEqual: typeof notStrictEqual; deepEqual: typeof deepEqual; notDeepEqual: typeof notDeepEqual;
  deepStrictEqual: typeof deepStrictEqual; notDeepStrictEqual: typeof notDeepStrictEqual; throws: typeof throws;
  doesNotThrow: typeof doesNotThrow; rejects: typeof rejects; doesNotReject: typeof doesNotReject; match: typeof match;
  doesNotMatch: typeof doesNotMatch; ifError: typeof ifError; strict: Assert;
}
function makeAssert(strictMode: boolean): Assert {
  // a function object of its own: `assert` and `assert.strict` differ in their loose forms
  const base: (value: unknown, message?: string | Error) => void = strictMode
    ? (value: unknown, message?: string | Error): void => { ok(value, message); }
    : (value: unknown, message?: string | Error): void => { ok(value, message); };
  const a = base as Assert;
  a.AssertionError = AssertionError;
  a.fail = fail; a.ok = ok;
  a.equal = strictMode ? strictEqual : equal;
  a.notEqual = strictMode ? notStrictEqual : notEqual;
  a.strictEqual = strictEqual; a.notStrictEqual = notStrictEqual;
  a.deepEqual = strictMode ? deepStrictEqual : deepEqual;
  a.notDeepEqual = strictMode ? notDeepStrictEqual : notDeepEqual;
  a.deepStrictEqual = deepStrictEqual; a.notDeepStrictEqual = notDeepStrictEqual;
  a.throws = throws; a.doesNotThrow = doesNotThrow; a.rejects = rejects; a.doesNotReject = doesNotReject;
  a.match = match; a.doesNotMatch = doesNotMatch; a.ifError = ifError;
  return a;
}
const strictAssert = makeAssert(true);
export const strict: Assert = strictAssert;
strictAssert.strict = strictAssert;
const assert: Assert = makeAssert(false);
assert.strict = strictAssert;
export default assert;
