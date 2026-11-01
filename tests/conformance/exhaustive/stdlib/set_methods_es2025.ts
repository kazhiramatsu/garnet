// @ts-nocheck
// @oracle esnext
// The ES2025 Set methods over a Set and over any set-like; Object.groupBy and Map.groupBy.
const log = (...a) => console.log(...a);
const name = (f) => { try { return f(); } catch (e) { return e.name; } };
const a = new Set([1, 2, 3]), b = new Set([2, 3, 4]);
log([...a.union(b)], [...a.intersection(b)], [...a.difference(b)], [...a.symmetricDifference(b)]);
log(new Set([2]).isSubsetOf(a), a.isSubsetOf(new Set([2])), a.isSupersetOf(new Set([2])), new Set([9]).isSupersetOf(a), a.isDisjointFrom(new Set([9])), a.isDisjointFrom(b));
log(a.union(b) instanceof Set, a.size, b.size, Set.prototype.union.length, Set.prototype.isSubsetOf.name);
log([...new Set([1, 2, 3, 4]).intersection(new Set([4, 2]))], [...new Set([4, 2]).intersection(new Set([1, 2, 3, 4]))]);
const like = { size: 2, has(v) { return v === 2; }, keys() { return [2, 7][Symbol.iterator](); } };
log([...a.union(like)], [...a.intersection(like)], [...a.difference(like)], [...a.symmetricDifference(like)]);
log(new Set([2]).isSubsetOf(like), a.isSupersetOf({ size: 1, has: () => true, keys: () => [1][Symbol.iterator]() }));
log(a.union(new Map([[8, 1]])).has(8));
let closed = 0;
const closing = { size: 1, has: () => true, keys() { return { next() { return { done: false, value: 99 }; }, return() { closed++; return {}; } }; } };
log(a.isSupersetOf(closing), closed);
log(name(() => a.union(1)), name(() => a.union({})), name(() => a.union({ size: NaN, has() {}, keys() {} })), name(() => a.union({ size: -1, has() {}, keys() {} })));
log(name(() => a.union({ size: 1, has: 1, keys() {} })), name(() => a.union({ size: 1, has() {}, keys: 1 })), name(() => Set.prototype.union.call({}, b)));
const typed: Set<number> = new Set([1]); log([...typed.union(new Set([2]))], typed.isSubsetOf(new Set([1, 2])));
const g = Object.groupBy([1, 2, 3, 4], (x, i) => (x % 2 ? "odd" : "even") + (i > 9 ? "x" : ""));
log(g, Object.getPrototypeOf(g), Object.keys(g));
const m = Map.groupBy([1, 2, 3], (x) => x % 2); log(m.get(1), m.get(0), m instanceof Map, [...m.keys()]);
log([...Map.groupBy([-0, 0], (x) => x).keys()].map((k) => Object.is(k, 0)));
log(Object.groupBy("abca", (c) => c), name(() => Object.groupBy(null, (x) => x)), name(() => Object.groupBy([], 1)), Object.groupBy.length, Map.groupBy.name);
