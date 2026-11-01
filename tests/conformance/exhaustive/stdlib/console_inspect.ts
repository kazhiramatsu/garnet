// console.log as Node prints: depth, circular references, the line breaks at 80 columns, grouped arrays, the format specifiers.
class A { x = 1; y = "s"; z = [1, 2]; }
class B extends A { w = { a: 1 }; }
class E0 {}
function f() {}
const arrow = () => 1;
async function af() {}
function* gen() { yield 1; }
async function* ag() { yield 1; }
const sym = Symbol("s");
console.log(1, "a", true, null, undefined, -0, NaN, sym, 12n);
console.log([1, "a", true, null, undefined, -0, sym, 12n]);
console.log({ a: 1, "b-c": 2, 3: 4, [sym]: 5, $d: 6, _e: 7, "__proto__x": 8 });
console.log(new A(), new B(), new E0());
console.log([new A()], { a: new B() });
console.log(f, arrow, af, gen, ag, class X {}, class extends A {}, A, B);
console.log(Object.assign(function g() {}, { a: 1 }), Object.assign(() => 1, { b: 2 }));
console.log(new Map<any, any>([[1, { a: 1 }], ["x", [1, 2]]]), new Set<any>([1, "a", { b: 2 }]), new Map(), new Set());
console.log(new WeakMap(), new WeakSet());
const rej = Promise.reject(1); rej.catch(() => 0);
console.log(Promise.resolve(4), rej, new Promise(() => {}), Promise.resolve({ a: 1 }));
console.log(new Date(0), new Date(NaN), /a+b/gi, new RegExp("x"));
console.log(new Uint8Array(3), new Float64Array([1.5, 2]), new ArrayBuffer(4), new BigInt64Array(2));
console.log(new Number(3), new String("abc"), new Boolean(false), (Object as any)(sym), (Object as any)(1n));
console.log(Object.create(null), Object.create({ a: 1 }), Object.assign(Object.create(null), { x: 1 }));
console.log({ a: { b: { c: { d: 1 } } } }, [[[[1]]]], { a: [{ b: [{ c: 1 }] }] });
console.log({ f() {}, g: () => 1, get h() { return 1; }, set h(v: number) {}, get i() { return 2; }, set j(v: number) {} });
const circ: any = { name: "c" }; circ.self = circ; circ.list = [circ, { p: circ }];
console.log(circ);
const a2: any[] = [1]; a2.push(a2); console.log(a2);
const c3: any = { a: {} }; c3.a.b = c3.a; c3.c = c3; console.log(c3);
console.log(Array.from({ length: 120 }, (_, i) => i));
console.log(Array.from({ length: 7 }, (_, i) => "item" + i));
console.log(Array.from({ length: 30 }, (_, i) => "item" + i * 100));
console.log(Array.from({ length: 27 }, (_, i) => i * 1234));
console.log(Array.from({ length: 10 }, (_, i) => ({ i })));
console.log(Array.from({ length: 8 }, (_, i) => [i, i + 1]));
console.log(new Set(Array.from({ length: 120 }, (_, i) => i)));
console.log(new Map(Array.from({ length: 3 }, (_, i) => [i, "v".repeat(30)])));
console.log(new Uint8Array(200));
console.log("x".repeat(100), ["x".repeat(100)], { s: "y".repeat(200) });
console.log(["a\nb", "it's", 'q"x', `a'b"c`, "a'b\"c`d", "\t\x01\x7f", "\ud83d", "😀", "日本語"]);
console.log({ text: "line1\nline2\nline3 with some more text to make it long enough to break at some point maybe" });
console.log({ a: 1, b: "two", c: [3, 4, 5], d: { e: 6 }, f: true, g: null, h: undefined, i: "a long string value here", j: 12345678 });
console.log({ aaaaaaaaaaaaaaaaaaaaaaaaaaaa: 1, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 2, cccccccccccccccccccccccc: 3 });
console.log({ aaaaaaaaaaaaaaaaaaaaaaaaaaaa: 1, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 2, cccccccccccccccccccccccc: 3, d: 4 });
console.log([{ a: 1, b: 2 }, { a: 3, b: 4 }], [[1, 2], [3, 4]], [{}, []], [[]], {}, []);
console.log([, 1, , , 2, , ], new Array(5), new Array<any>(3).concat([1]), Object.assign([1, 2], { x: 1, [sym]: 2 }));
console.log(Object.defineProperty({}, "hidden", { value: 1, enumerable: false }), Object.defineProperty([], "x", { value: 1, enumerable: true }));
console.log(new Proxy({ a: 1 }, {}), new Proxy([1, 2], {}), new Proxy(function pf() {}, {}));
const rv = Proxy.revocable({}, {}); rv.revoke(); console.log(rv.proxy);
console.log(new Map([[{ a: 1 }, new Set([1])]]), [new Map([[1, 2]])], { m: new Map([[1, { a: { b: 1 } }]]) });
class M2 extends Map<any, any> { extra = 1; }
class S2 extends Set<any> {}
class AR extends Array<any> { }
console.log(new M2([[1, 2]]), new S2([1]), AR.from([1, 2]), new AR(), new M2());
class T { get [Symbol.toStringTag]() { return "Tagged"; } }
console.log(new T(), { [Symbol.toStringTag]: "own" }, Object.create(null, { [Symbol.toStringTag]: { value: "nul" } }));
console.log(Math, JSON, Reflect, Atomics, globalThis === undefined);
console.log(new Map([[1, 2]]).entries(), new Map([[1, 2]]).keys(), new Map([[1, 2]]).values(), new Set([1]).values(), new Set([1]).entries(), [1].values(), gen(), ag(), "abc"[Symbol.iterator](), "a".matchAll(/a/g));
const it = new Map([[1, 2], [3, 4]]).keys(); it.next(); console.log(it);
function args(..._a: any[]) { return arguments; }
console.log(args(1, 2));
console.log(new (class Foo { constructor() { (this as any).self = this; } })());
console.log("%s is %d and %i, %f, %j %o %O %%, %c.", "x", 4.5, 4.5, "1.5", { a: 1 }, [1], { b: 2 }, "css", "extra", 5);
console.log("%s", { a: 1 }, "%s", new A(), f, null, undefined, 12n, sym, -0);
console.log("%d %d %d %d", "12", null, 12n, sym, "%i", "a");
console.log("%o", { a: [1, { b: 2 }], f() {} });
console.log("100%", 5, "%");
console.log("%s", "a", "b", { c: 1 });
console.log("%s %s", { toString() { return "custom"; } }, new (class Q { toString() { return "Q!"; } })());
console.log("%s", new Error("e").message, new Date(0), [1, [2, [3]]]);
