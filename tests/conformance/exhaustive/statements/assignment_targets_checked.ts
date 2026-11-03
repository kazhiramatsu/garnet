// @ts-nocheck
const t = (f) => { try { console.log("ok", f()); } catch (e) { console.log(e.name, e.message.slice(0, 40)); } };
const arrow = () => {}; function fn() {}
console.log(arrow.hasOwnProperty("caller"), arrow.hasOwnProperty("arguments"), fn.hasOwnProperty("caller"));
t(() => arrow.caller); t(() => { arrow.caller = {}; }); t(() => arrow.arguments); t(() => { arrow.arguments = {}; });
t(() => fn.caller); t(() => Math.max.caller);
const dc = Object.getOwnPropertyDescriptor(Function.prototype, "caller");
console.log(typeof dc.get, dc.enumerable, dc.configurable);
// patterns over values with no iterator in the type
var iterable = {}; iterable[Symbol.iterator] = function () { throw new RangeError("get"); };
var _; t(() => { 0, [_] = iterable; return 1; });
var n1 = 1; const tt = (f) => { try { f(); console.log("no throw"); } catch (e) { console.log(e.name); } }; tt(() => { 0, [] = n1; }); tt(() => { 0, [_] = null; }); tt(() => { 0, [_] = undefined; });
const cc = 1; t(() => { [cc] = [2]; return cc; }); t(() => { ({ a: cc } = { a: 2 }); return cc; }); t(() => { ({ cc } = { cc: 2 }); return cc; }); t(() => { [...cc] = [2]; return cc; });
t(() => { cc = 2; return cc; }); t(() => { cc += 2; return cc; }); t(() => { cc++; return cc; });
let lt; t(() => { [lt] = [2]; return lt; });
t(() => { [unresolvable] = []; return 1; }); t(() => { ({ unresolvable } = {}); return 1; }); t(() => { unresolvable = 1; return 1; });
t(() => { let c2 = 1; { const c3 = 2; c3 = 3; } return c2; });
t(() => { for (const i = 0; i < 2; i++) { } return 1; });
t(() => { for (const k of [1]) { k = 2; } return 1; });
class K { m() { K = 1; } } t(() => new K().m());

class L {} L = 5; console.log(L);
