// @ts-nocheck
// The name of a named function expression, written at module level: its body and the closures in it read the
// function (they read a local nobody set, undefined, silently; a value read or a call from a closure failed).
const a = function f() { return () => f; };
console.log(typeof a()(), a()() === a);
const b = function g(n) { return [1].map(() => (n ? g(0) : "leaf")); };
console.log(b(1));
const c = function h() { return h; };
console.log(c() === c);
const d = [[1, [2]], 3].map(function visit(x) { return Array.isArray(x) ? x.map(visit) : x * 2; });
console.log(d);
var probe;
var func = function f2() { probe = function () { return f2; }; };
var f2 = "outside";
func();
console.log(f2, probe() === func);
var probeBefore = function () { return f3; };
var setBefore = function () { f3 = null; };
var f3 = "outside";
var probeBody, setBody;
var func3 = function f3() { probeBody = function () { return f3; }; setBody = function () { f3 = null; }; };
func3();
console.log(probeBefore(), probeBody() === func3);
setBefore();
console.log(probeBefore(), probeBody() === func3);
try { setBody(); } catch (e) { console.log(e.name); }
console.log(probeBody() === func3);
const g3 = function* gen() { yield gen; };
console.log(g3().next().value === g3);
const af = async function self() { return self; };
af().then((v) => console.log(v === af));
const obj = { m: function inner() { return () => inner; } };
console.log(obj.m()() === obj.m);
function F() { console.log((() => new.target)() === undefined ? "called" : "constructed"); }
F(); new F();
const K = class Inner { static make() { return new Inner(); } m() { return () => Inner; } };
console.log(K.make() instanceof K, new K().m()() === K);
