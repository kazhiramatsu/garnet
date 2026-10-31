// @ts-nocheck
// The arguments object: one array per activation, seen by arrows, in generators, async functions and methods.
function plain(a, b) { arguments[0] = 9; return [a, arguments[0], arguments.length, arguments === arguments]; }
function arrow(a) { const f = () => arguments[0] + arguments.length; const g = () => () => arguments.length; return [f(), g()()]; }
function* gen(a, b) { yield arguments.length; yield arguments[1]; yield [...arguments].join(); const h = () => arguments[0]; yield h(); }
async function as(a) { await null; const r = arguments.length; await null; return [r, arguments[0], Array.from(arguments).join()]; }
async function* ag() { yield arguments.length; await 1; yield arguments[0]; }
const o = { m() { return arguments.length; }, async am() { return arguments.length; }, *gm() { yield arguments[1]; } };
class C { m() { return (() => arguments.length)(); } async am() { return arguments[0]; } *gm() { yield arguments.length; } static s() { return arguments.length; } constructor() { this.n = arguments.length; } }
function len() { return arguments.length; }
console.log(plain(1, 2), arrow(1, 2), [...gen(1, 2, 3)], o.m(1, 2), [...o.gm(1, 2)], new C(1, 2).n, new C().m(1), C.s(1, 2, 3), [...new C().gm(1, 2)], len(), len(1));
as(1, 2).then(console.log); o.am(1).then(console.log); new C().am(7).then(console.log);
(async () => { for await (const x of ag(5, 6)) console.log(x); })();
try { (() => arguments)(); } catch (e) { console.log(e.name); }
