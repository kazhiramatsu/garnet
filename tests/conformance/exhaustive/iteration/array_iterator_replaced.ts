// @ts-nocheck
const orig = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function* () { if (this.length > 0) yield this[0]; if (this.length > 1) yield this[1]; if (this.length > 2) yield 42; };
const f = ([x, y, z]) => [x, y, z].length + ":" + z;
console.log(f([1, 2, 3]));
const [a, b, c] = [1, 2, 3]; console.log(c);
let p, q, r; [p, q, r] = [1, 2, 3]; console.log(r);
const out = []; for (const v of [1, 2, 3]) out.push(v); console.log(out.length, out[2]);
console.log([...[1, 2, 3]][2]);
function g() { return arguments.length; } console.log(g(...[1, 2, 3, 4]));
console.log(Array.from([1, 2, 3])[2], new Set([1, 2, 3]).has(42));
Array.prototype[Symbol.iterator] = orig;
delete Array.prototype[Symbol.iterator];
const t = (fn) => { try { console.log("ok", fn()); } catch (e) { console.log(e.name); } };
t(() => { const [m] = [1]; return m; });
t(() => { for (const v of [1]) return v; });
t(() => [...[1]]);
t(() => g(...[1]));
