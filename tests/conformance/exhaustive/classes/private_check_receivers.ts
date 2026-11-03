// @oracle esnext
// @ts-nocheck
// A private check is a test of the class index in line (docs/private_names_design.md). Every receiver outside the declaring
// class's interval takes the runtime's answer: each kind of cell here, on a field, a brand and an accessor's brand.
const t = (f) => { try { return f(); } catch (e) { return e.name + ":" + (e.constructor === TypeError); } };
class A { #x = 1; #m() { return 2; } get #g() { return 3; } x() { return this.#x; } m() { return this.#m(); } g() { return this.#g; } w(v) { this.#x = v; return this.#x; } }
class B extends A { #y = 4; y() { return this.#y; } }
class C extends A { #y = 5; y() { return this.#y; } }
class D extends C {}
class E { #x = 6; x() { return this.#x; } }
class F { static #s = 7; static s() { return this.#s; } }
class G extends F {}
const calls = [["A.x", A.prototype.x], ["A.m", A.prototype.m], ["A.g", A.prototype.g], ["A.w", A.prototype.w], ["B.y", B.prototype.y], ["C.y", C.prototype.y], ["E.x", E.prototype.x], ["F.s", F.s]];
function* gen() { yield 1; }
async function* agen() { yield 1; }
const receivers = [
  ["A", new A()], ["B", new B()], ["C", new C()], ["D", new D()], ["E", new E()], ["F", F], ["G", G], ["new F", new F()],
  ["plain", {}], ["one key", { x: 1 }], ["array", [1, 2, 3]], ["function", function () {}], ["arrow", () => 1], ["class", A], ["bound", A.prototype.x.bind(new A())],
  ["derived", Object.create(new A())], ["derived B", Object.create(new B())], ["proxy", new Proxy(new A(), {})], ["proxy of plain", new Proxy({}, {})], ["proxy of function", new Proxy(function () {}, {})],
  ["prototype", A.prototype], ["B prototype", B.prototype], ["null proto", Object.create(null)],
  ["relinked B", Object.setPrototypeOf(new B(), null)], ["relinked A", Object.setPrototypeOf(new A(), { other: 1 })], ["relinked to B", Object.setPrototypeOf(new A(), B.prototype)],
  ["map", new Map()], ["set", new Set()], ["weakmap", new WeakMap()], ["date", new Date(0)], ["regexp", /x/], ["error", new Error("e")],
  ["promise", Promise.resolve(1)], ["generator", gen()], ["async generator", agen()], ["array iterator", [1][Symbol.iterator]()], ["map iterator", new Map().keys()],
  ["buffer", new ArrayBuffer(8)], ["typed array", new Uint8Array(4)], ["data view", new DataView(new ArrayBuffer(4))],
  ["number object", new Number(1)], ["string object", new String("s")], ["boolean object", new Boolean(true)], ["symbol object", Object(Symbol("s"))], ["bigint object", Object(1n)],
  ["symbol", Symbol("s")], ["bigint", 1n], ["bigint 2", 2n], ["bigint 3", 3n], ["bigint 7", 7n], ["number", 1], ["string", "s"], ["true", true], ["null", null], ["undefined", undefined],
];
for (const [cn, f] of calls) for (const [rn, r] of receivers) console.log(cn, rn, t(() => f.call(r, 9)));

// many calls over one site with a mix, in a loop the compiler may keep hot
const read = A.prototype.x;
let ok = 0, bad = 0;
for (let i = 0; i < 2000; i++) {
  const r = receivers[i % receivers.length][1];
  try { read.call(r); ok++; } catch (e) { bad++; }
}
console.log(ok, bad);
