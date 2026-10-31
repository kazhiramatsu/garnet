// @oracle esnext
// @ts-nocheck
var b, c, d, e, f, g, h, i, j;
const nm = (x) => x && Object.getOwnPropertyDescriptor(x, "name") ? JSON.stringify(x.name) : "none";
b = class {}; console.log(nm(b));
c = function () {}; console.log(nm(c));
d = () => {}; console.log(nm(d));
e = undefined; e ??= class {}; console.log(nm(e));
f = 0; f ||= function () {}; console.log(nm(f));
g = 1; g &&= () => {}; console.log(nm(g));
const o = { a: class {}, b: function () {}, c: () => {}, ["d" + 1]: class {}, ["e" + 1]: function () {}, ["f" + 1]: () => {}, [Symbol.iterator]: class {}, 5: class {}, "s t": function () {} };
for (const k of Reflect.ownKeys(o)) console.log(String(k), nm(o[k]));
function p1(a = class {}, b = function () {}, c = () => {}) { console.log(nm(a), nm(b), nm(c)); }
p1();
const [x1 = class {}, x2 = function () {}, x3 = () => {}] = [];
console.log(nm(x1), nm(x2), nm(x3));
const { y1 = class {}, y2 = function () {}, y3 = () => {}, z: z1 = class {} } = {};
console.log(nm(y1), nm(y2), nm(y3), nm(z1));
var a1, a2, a3, a4;
[a1 = class {}, a2 = function () {}] = [];
({ a3 = class {}, q: a4 = () => {} } = {});
console.log(nm(a1), nm(a2), nm(a3), nm(a4));
class C1 { x = class {}; y = function () {}; z = () => {}; static s = class {}; static t = function () {}; #p = class {}; gp() { return this.#p; } ["c" + 1] = class {}; static ["d" + 1] = () => {}; }
const ci = new C1();
console.log(nm(ci.x), nm(ci.y), nm(ci.z), nm(C1.s), nm(C1.t), nm(ci.gp()), nm(ci.c1), nm(C1.d1));
// the class's own static name wins
const k1 = class { static name = "own"; };
const k2 = class { static name() {} };
const k3 = class { static get name() { return "getter"; } };
console.log(k1.name, typeof k2.name, k3.name);
// not anonymous forms
const n1 = class N {}, n2 = function M() {}, n3 = (class {}), n4 = (function () {}), n5 = (0, class {}), n6 = (0, function () {});
console.log(nm(n1), nm(n2), nm(n3), nm(n4), nm(n5), nm(n6));
var ax = {}; ax.q = class {}; ax["r"] = function () {}; console.log(nm(ax.q), nm(ax.r));
