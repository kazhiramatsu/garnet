import { isObject, isArray, hasOwn, extend, nextId, twice, compose, quad, probe, early, lateHelper } from "./index";
const o = extend({}, { a: 1 });
const inc = compose(twice, (n: number) => n + 1);
console.log(isObject(o), isObject(1), isArray([]), isArray(o), hasOwn(o, "a"), hasOwn(o, "b"), nextId(), nextId(), twice(21), quad(3), inc(5));
console.log(probe, early(), lateHelper(1), [1, 2].map(twice).join(","), twice === twice, typeof compose);
