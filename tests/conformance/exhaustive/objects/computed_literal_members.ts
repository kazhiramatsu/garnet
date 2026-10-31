// @ts-nocheck
// Methods and accessors of an object literal under computed, numeric and string names, named from the key.
const k = "dyn"; const s = Symbol("sy");
const o = {
  [k + 1]() { return 1; }, 2() { return 2; }, "str"() { return 3; }, [s]() { return 4; },
  get [k]() { return 5; }, set [k](v) { this.w = v; }, get 7() { return 7; }, get [s]() { return 8; },
};
console.log(o.dyn1(), o[2](), o.str(), o.dyn, o[7], o[s], Object.keys(o).join());
o.dyn = 9; console.log(o.w, o.dyn1.name, o[2].name, Object.getOwnPropertyDescriptor(o, "dyn").get.name, Object.getOwnPropertyDescriptor(o, "dyn").set.name, Object.getOwnPropertyDescriptor(o, s).get.name, Object.getOwnPropertyDescriptor(o, "dyn").enumerable);
const it = { [Symbol.asyncIterator]: 1, get [Symbol.iterator]() { return function* () { yield 1; }; } };
console.log([...it]);
function* g(o) { yield* o; } console.log([...g({ [Symbol.iterator]() { return [1, 2].values(); } })]);
