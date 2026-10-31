// @ts-nocheck
const log = (...a) => console.log(...a.map((x) => JSON.stringify(x)));
var a, b, c, d, r, o = {}, k = "kk";
({ "x y": a, 5: b, [k]: c, ...r } = { "x y": 1, 5: 2, kk: 3, rest1: 4, rest2: 5 });
log(a, b, c, r);
({ [k]: o.p = 9, q: o["z"] = 8, ...o.rest } = { kk: undefined, other: 1 });
log(o);
// order: target reference, then value read, then default
var seq = [];
var src = { get a() { seq.push("get a"); return undefined; }, get b() { seq.push("get b"); return 1; } };
var tgt = () => { seq.push("target"); return {}; };
var dflt = () => { seq.push("default"); return 1; };
({ a: tgt().x = dflt(), b: tgt().y } = src);
log(seq);
// coercible
for (const f of [() => { ({} = null); }, () => { ({ ...a } = undefined); }, () => { ({ [(seq.push("key"), "q")]: a } = null); }, () => { const {} = undefined; }, () => { const { ...z } = null; }, () => { const { [(seq.push("key2"), "q")]: z } = null; }]) {
  try { f(); console.log("no throw"); } catch (e) { console.log(e.name); }
}
log(seq);
// rest with computed key, arrays, strings, functions, symbols
const s1 = Symbol("s1");
const { [k]: x1, ...r1 } = { kk: 1, y: 2, [s1]: 3 };
log(x1, r1, Object.getOwnPropertySymbols(r1).length);
const { 0: x2, ...r2 } = [1, 2, 3];
log(x2, r2);
const { length, ...r3 } = "abc";
log(length, r3);
function fw() {} fw.p = 1; fw.q = 2;
const { p: x4, ...r4 } = fw;
log(x4, r4);
const { ...r5 } = 5; log(r5);
const { ...r6 } = true; log(r6);
// a key's ToPropertyKey once, before the value
var n = 0;
const kobj = { toString() { n++; seq.push("toString"); return "t"; } };
seq = [];
const lit = { [kobj]: (seq.push("value"), 1) };
log(seq, n, lit);
n = 0; seq = [];
const { [kobj]: x7, ...r7 } = { t: 1, u: 2 };
log(n, x7, r7);
n = 0; seq = [];
var x8, r8;
({ [kobj]: x8, ...r8 } = { t: 1, u: 2 });
log(n, x8, r8);
// primitives as sources
({ length: a } = "abcd"); log(a);
({ toFixed: a } = 1); log(typeof a);
// value of the expression
var t = ({ a } = { a: 1 }); log(t);
