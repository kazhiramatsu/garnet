// node:assert: the assertions, AssertionError's fields, throws/rejects validation, the strict variant.
import assert, { AssertionError, strictEqual, deepStrictEqual, throws, rejects, match } from "node:assert";
import strict from "node:assert/strict";
function fails(f: () => unknown): string {
  try { f(); return "no-throw"; }
  catch (e) {
    if (e instanceof AssertionError) return "AE:" + e.code + ":" + e.operator + ":" + e.generatedMessage + ":" + String(e.actual) + ":" + (typeof e.expected === "function" ? (e.expected as { name: string }).name : String(e.expected)) + ":" + e.name;
    return (e as Error).constructor.name + ":" + (e as Error).message;
  }
}
async function main(): Promise<void> {
  const out: string[] = [];
  assert(true); assert.ok(1); strictEqual(1, 1); assert.equal(1, "1"); assert.notEqual(1, 2); assert.notStrictEqual(1, "1");
  deepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }); assert.deepEqual([1], ["1"]); assert.notDeepStrictEqual([1], ["1"]);
  assert.doesNotThrow(() => 1); match("abc", /b/); assert.doesNotMatch("abc", /z/); assert.ifError(null); assert.ifError(undefined);
  out.push("passes");
  out.push([fails(() => assert.strictEqual(1, 2)), fails(() => assert.ok(0)), fails(() => assert.equal(1, 2, "custom")), fails(() => assert.fail()), fails(() => assert.fail("why"))].join("|"));
  out.push([fails(() => assert.deepStrictEqual({ a: 1 }, { a: "1" })), fails(() => assert.notStrictEqual(2, 2)), fails(() => assert.match("abc", /z/)), fails(() => assert.ifError(new Error("inner"))), fails(() => assert.fail(new TypeError("own")))].join("|"));
  out.push([fails(() => throws(() => { throw new RangeError("r"); }, RangeError)), fails(() => throws(() => { throw new RangeError("r"); }, TypeError)), fails(() => throws(() => 1)), fails(() => throws(() => { throw new Error("abc"); }, /b/)), fails(() => throws(() => { throw new Error("abc"); }, { message: "abc", name: "Error" })), fails(() => throws(() => { throw new Error("abc"); }, (e: unknown) => e instanceof Error)), fails(() => throws(() => { throw new Error("abc"); }, { message: /z/ }))].join("|"));
  let r = "";
  try { await rejects(Promise.reject(new Error("rej")), Error); r += "ok1,"; } catch (e) { r += "bad1,"; }
  try { await rejects(async () => 1); r += "bad2,"; } catch (e) { r += (e as AssertionError).code + ","; }
  try { await assert.doesNotReject(Promise.resolve(1)); r += "ok3"; } catch (e) { r += "bad3"; }
  out.push(r);
  out.push([fails(() => strict.equal(1, "1")), fails(() => strict.deepEqual([1], ["1"])), fails(() => assert.strict.notDeepEqual([1], [1])), strict === assert.strict, strict.strict === strict].join("|"));
  const e = new AssertionError({ message: "m", actual: 1, expected: 2, operator: "op" });
  out.push([e.message, e.code, e.generatedMessage, e.actual, e.expected, e.operator, e instanceof Error, e.name].join("|"));
  console.log(out.join("\n"));
}
main();
