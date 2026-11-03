// @oracle esnext
// @ts-nocheck
// Generated code reads a cell's class and shape words before it knows the cell's kind. A BigInt keeps both zero, as a
// Symbol, a Proxy and a coroutine do; with its first limb there, `1n instanceof A` was true (silent).
class A { x = 1; y = "field"; m() { return "method"; } get g() { return "getter"; } }
class B extends A { z = 2; }
class C { x = 3; }
class D extends C { w = 4; }
const hits = [];
for (let i = -8n; i < 2048n; i++) {
  if (i instanceof A) hits.push("A" + i);
  if (i instanceof B) hits.push("B" + i);
  if (i instanceof C) hits.push("C" + i);
  if (i instanceof D) hits.push("D" + i);
}
console.log(hits.length, hits.slice(0, 8));

// a read, a call and a write through a site that has seen objects: the upper half of the limb is where a shape is
const read = (o) => o.x;
const readM = (o) => o.m;
const has = (o) => { try { return "x" in o; } catch (e) { return e.name; } };
const plain = { x: 1 }, other = { a: 1, x: 2 }, inst = new A();
let seen = 0;
for (let i = 0n; i < 4096n; i++) {
  for (const o of [plain, other, inst]) { read(o); readM(o); }
  for (const v of [i, i << 32n, -i, i << 64n]) {
    if (read(v) !== undefined) seen++;
    if (readM(v) !== undefined) seen++;
  }
}
console.log(seen);
console.log(has(1n), has(inst));

// the operations that ask for an object or a class
const t = (f) => { try { return f(); } catch (e) { return e.name; } };
for (const v of [0n, 1n, 2n, 3n, 4n, 5n, -1n, 2n ** 32n, 2n ** 64n, 3n * 2n ** 64n]) {
  console.log(String(v), typeof v, Object(v) instanceof BigInt, t(() => v.toString(16)), t(() => Object.keys(v)), t(() => JSON.stringify({ a: 1, b: typeof v })), t(() => v.constructor === BigInt), t(() => Object.getPrototypeOf(v) === BigInt.prototype));
}
console.log(t(() => Reflect.ownKeys(1n)), t(() => new WeakMap().set(1n, 1)), t(() => new WeakSet().add(1n)), t(() => Object.getOwnPropertyDescriptor(1n, "x")), t(() => structuredClone(1n)));
for (const v of [1n, 2n ** 64n, 2n ** 128n + 1n]) console.log(t(() => Object.hasOwn(v, "x")), t(() => Object.prototype.hasOwnProperty.call(v, "toString")), t(() => Object.prototype.propertyIsEnumerable.call(v, "x")), t(() => Object.create(v)));

// a method taken from a class and called on a BigInt
console.log(t(() => A.prototype.m.call(1n)), t(() => Object.getOwnPropertyDescriptor(A.prototype, "g").get.call(2n)));
class E { f() { return this; } get v() { return this; } }
console.log(typeof E.prototype.f.call(1n), typeof Object.getOwnPropertyDescriptor(E.prototype, "v").get.call(2n));

// arithmetic and comparison on values as large as the words read: the layout moved the limbs
console.log((2n ** 200n + 3n) * (2n ** 100n - 1n), (2n ** 200n) / 3n, -(2n ** 70n) % 7n, (1n << 130n) >> 65n, 2n ** 64n === 2n ** 64n, 2n ** 64n > 2n ** 63n, new Map([[1n, "a"]]).get(1n), new Set([2n ** 64n]).has(2n ** 64n));
console.log(BigInt.asUintN(64, -1n), BigInt.asIntN(8, 255n), new BigInt64Array([-1n])[0], new BigUint64Array([2n ** 64n - 1n])[0], Number(2n ** 53n), BigInt(2 ** 53), BigInt("0xff"));
