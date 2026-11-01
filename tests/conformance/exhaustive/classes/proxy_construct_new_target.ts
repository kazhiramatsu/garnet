class C { x = 1; constructor(public a: number) {} }
const PC = new Proxy(C, {});
const c = new PC(5);
console.log(c instanceof C, c.a, c.x);
function F(this: any, a: number) { this.a = a; console.log(new.target === PF, new.target === F); }
const PF: any = new Proxy(F, { get(t, k, r) { if (k === "prototype") console.log("get prototype"); return Reflect.get(t, k, r); } });
const f = new PF(2);
console.log(f.a, f instanceof F);
const PM: any = new Proxy(Map, {});
const m = new PM([[1, 2]]);
console.log(m.get(1), m instanceof Map);
const PD: any = new Proxy(Date, {});
console.log(new PD(0).getTime());
const PA: any = new Proxy(Array, {});
console.log(new PA(3).length, Array.isArray(new PA(1, 2)));
class D extends C { y = 2; }
const PDD = new Proxy(D, {});
const d = new PDD(1);
console.log(d.y, d.x, d instanceof D);
const PE: any = new Proxy(Error, {});
console.log(new PE("m").message, new PE("m") instanceof Error);
class Base { constructor() { console.log(new.target === Sub || new.target === PS); } }
class Sub extends Base {}
const PS = new Proxy(Sub, {});
new PS();
const PP: any = new Proxy(new Proxy(C, {}), {});
console.log(new PP(9).a);
