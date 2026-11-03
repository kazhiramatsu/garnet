// @oracle esnext
// @ts-nocheck
// Integer keys come first on every kind of object: a class instance's after its fields, a function's after length, name and
// prototype. JSON.stringify of a class instance with an integer key wrote its fields twice, the first copy cut by a byte
// (silent: it backed up over one byte, a `{`, after it had written the fields). Object.assign skipped a function's own
// properties and a Map's or a Set's, spread a Map's or a Set's (silent).
class A { a: any = 1; b: any = 0.1; c?: any; constructor(public d: any) {} }
class B extends A { e: any = 1e21; }
const o: any = new B(2.5);
o[0] = "1";
const c = o as B;
const s = JSON.stringify(c);
console.log(s.length, s, JSON.stringify(c, null, 1));
console.log(Object.keys(c), Object.getOwnPropertyNames(c), Reflect.ownKeys(c), Object.entries(c), { ...c }, Object.assign({}, c));
class D { a = 1; b = 2; }
const d: any = new D(); d[5] = 1; d.z = 2; d[1] = 0;
console.log(Object.getOwnPropertyNames(d), Reflect.ownKeys(d), Object.keys(d), JSON.stringify(d), Object.entries(d), { ...d });
const f: any = function () { return 1; }; f.a = 1; f[7] = 2; f[0] = 3; f.z = 4;
console.log(Object.getOwnPropertyNames(f), Reflect.ownKeys(f), Object.keys(f), JSON.stringify(Object.assign({}, f)), { ...f });
class S { static s = 1; static m() {} } (S as any)[3] = 1;
console.log(Object.getOwnPropertyNames(S), Reflect.ownKeys(S).map(String), Object.keys(S));
const arrow: any = () => 1; arrow[2] = 1; arrow.b = 2; console.log(Object.getOwnPropertyNames(arrow), Object.assign({}, arrow));
const bound: any = f.bind(null); bound[1] = 1; console.log(Object.getOwnPropertyNames(bound));
const m: any = new Map([[1, 2]]); m.x = 1; const st: any = new Set([1]); st.y = 2;
console.log(Object.assign({}, m), Object.assign({}, st), { ...m }, { ...st }, Object.assign({}, 1n), Object.assign({}, Symbol("s")), Object.assign({}, "ab"), Object.assign({}, null, undefined, 1, true));
class K2 { static q = 1; } console.log(Object.assign({}, K2), Object.assign({}, function () {}));
