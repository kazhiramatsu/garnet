// node:assert/strict — the strict assertion module.
import { strict } from "../assert";
export { AssertionError, fail, ok, strictEqual, notStrictEqual, deepStrictEqual, notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch, ifError } from "../assert";
export const equal = strict.equal;
export const notEqual = strict.notEqual;
export const deepEqual = strict.deepEqual;
export const notDeepEqual = strict.notDeepEqual;
export default strict;
