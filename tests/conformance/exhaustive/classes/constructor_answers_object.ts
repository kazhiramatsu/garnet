class Base { constructor(o: any) { return o; } }
class Fi extends Base { pub = 6; other: number; constructor(o: any) { super(o); this.other = 7; console.log(this === o); } }
const o2: any = {};
const r = new Fi(o2);
console.log(r === o2, o2.pub, o2.other, Object.keys(o2));
class Fj extends Base { pub = 6; }
const o3: any = {};
const r3 = new Fj(o3);
console.log(r3 === o3, o3.pub, Object.keys(o3));
class PB { constructor() { return new Proxy(this, { get(t: any, k, r) { return k === "magic" ? 42 : Reflect.get(t, k, r); } }); } }
class PD extends PB { x = 1; m() { return (this as any).magic + this.x; } }
const pd = new PD();
console.log(pd.m(), pd.x, (pd as any).magic, pd instanceof PD, pd instanceof PB);
class Single { static inst: Single | undefined; n = 0; constructor() { if (Single.inst) return Single.inst; Single.inst = this; } inc() { return ++this.n; } }
new Single().inc();
console.log(new Single().inc(), new Single() === new Single());
class Prim { v = 1; constructor() { return 5 as any; } }
console.log(new Prim().v);
class Der extends Prim { w = 2; }
try { console.log(new Der()); } catch (e: any) { console.log(e.name); }
class RetObj { constructor() { return { a: 1 }; } }
console.log(new RetObj());
class D2 extends RetObj { b = 2; }
console.log(new D2(), new D2() instanceof D2);
class RU { x = 1; constructor(f: boolean) { if (f) return undefined as any; } }
console.log(new RU(true).x);
class D3 extends RU { constructor() { const r: any = super(true); console.log(r === this); return; } }
console.log(new D3().x);
