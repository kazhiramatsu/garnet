// The aliases imported from a shared module (vue's `@vue/shared`): the calls are the builtins,
// the values still cross the module boundary.
import { isArray, extend, hasOwn, isMap, objectToString } from "./shared";
import * as S from "./shared";
const o = extend({ a: 1 }, { b: 2 });
console.log(isArray([]), isArray(o), S.isArray([1]), JSON.stringify(o), hasOwn(o, "a"), hasOwn(o, "c"), isMap(new Map()), isMap(o));
console.log(objectToString.call(new Set()), S.toTypeString(null), [[], 1].map(isArray).join(","), typeof S.extend, S.extend === Object.assign);
