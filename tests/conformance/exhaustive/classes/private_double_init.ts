class Base { constructor(o: any) { return o; } }
function t(name: string, mk: () => any) { const o = {}; try { mk()(o); console.log(name, "first ok"); mk()(o); console.log(name, "no throw"); } catch (e: any) { console.log(name, e.name, e.message); } }
class F extends Base { #x = 1; }
class M extends Base { #m() {} }
class G extends Base { get #g() { return 1; } }
class S extends Base { set #s(v: number) {} }
t("field", () => (o: any) => new F(o));
t("method", () => (o: any) => new M(o));
t("get", () => (o: any) => new G(o));
t("set", () => (o: any) => new S(o));
class Fn extends Base { #y; static has(o: any) { return #y in o; } static get(o: any) { return o.#y; } }
const o1 = {};
new Fn(o1);
console.log(Fn.has(o1), Fn.get(o1), Object.keys(o1));
class Fi extends Base { #z = 5; pub = 6; static get(o: any) { return o.#z; } }
const o2: any = {};
new Fi(o2);
console.log(Fi.get(o2), o2.pub, Object.keys(o2));
