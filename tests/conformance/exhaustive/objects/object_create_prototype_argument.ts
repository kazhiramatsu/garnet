// @ts-nocheck
// Object.create's prototype is an object or null, as Object.setPrototypeOf's is: anything else made an object with no
// prototype (silent).
const t = (f) => { try { return f(); } catch (e) { return [e.name, e.constructor === TypeError]; } };
const cases = [["1", 1], ["0", 0], ["NaN", NaN], ["string", "s"], ["empty", ""], ["true", true], ["false", false], ["undefined", undefined], ["symbol", Symbol("q")], ["null", null],
  ["object", { a: 1 }], ["array", [1]], ["function", function () {}], ["arrow", () => 1], ["class", class {}], ["map", new Map()], ["proxy", new Proxy({}, {})]];
for (const [n, v] of cases) {
  console.log(n, t(() => Object.getPrototypeOf(Object.create(v)) === v), t(() => Object.keys(Object.create(v, { z: { value: 1, enumerable: true } }))), t(() => Object.getPrototypeOf(Object.setPrototypeOf({}, v)) === v));
}
const create = Object.create;
console.log(t(() => create(1)), t(() => create(null) instanceof Object), t(() => Object.create.call(null, undefined)), t(() => Reflect.apply(Object.create, null, ["s"])));
