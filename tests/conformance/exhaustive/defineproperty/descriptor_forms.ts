// @ts-nocheck
const o: any = {}; const k = 0; const kk: any = 1;
Object.defineProperty(o, k, { value: 1, enumerable: true, writable: true, configurable: true });
Object.defineProperty(o, kk, { value: 2, enumerable: true, writable: true, configurable: true });
console.log(o[0], o[1], JSON.stringify(o), Object.keys(o));
function cd(A: any, k: number, value: any) { Object.defineProperty(A, k, { value, writable: true, enumerable: true, configurable: true }); }
const p: any = {}; cd(p, 0, "a"); console.log(p[0], JSON.stringify(p));
const a: any[] = []; cd(a, 0, "a"); cd(a, 2, "c"); console.log(a, a.length);
const a2: any = new Array(3); cd(a2, 1, "x"); console.log(a2, a2.length);
const h = { get [Symbol.species]() { return this; }, get [Symbol.iterator]() { return 1; }, get x() { return 2; } };
console.log(Object.getOwnPropertySymbols(h).length, typeof Object.getOwnPropertyDescriptor(h, Symbol.species).get);
const d = Object.getOwnPropertyDescriptor(h, "x"); console.log(JSON.stringify({ ...d, enumerable: false }));
const d2 = Object.getOwnPropertyDescriptor(h, Symbol.iterator); console.log(JSON.stringify(d2));
console.log(typeof d2?.get, d2?.get?.name);
const dd: any = {}; const value = 5, get = () => 7;
Object.defineProperty(dd, "a", { value }); Object.defineProperty(dd, "b", { get });
Object.defineProperty(dd, "c", { get value() { return 9; } }); Object.defineProperty(dd, "d", { ["value"]: 3 });
Object.defineProperty(dd, "e", { ...{ value: 4 } });
const enumerable = true; Object.defineProperty(dd, "f", { value: 1, enumerable });
console.log(dd.a, dd.b, dd.c, dd.d, dd.e, Object.keys(dd));
