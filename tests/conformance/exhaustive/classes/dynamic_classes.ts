// @ts-nocheck
const log = (...a) => console.log(...a);
// mixin
const Mix = (B) => class extends B { hi() { return "hi " + this.n; } };
class Base { n = 1; who() { return "base"; } }
class M extends Mix(Base) { who() { return "m>" + super.who(); } }
const m = new M(); log(m.hi(), m.who(), m instanceof Base, m.n, Object.keys(m).join());
// a class in a function capturing its locals, one per evaluation
function make(tag) {
  let count = 0;
  class Local {
    static kind = tag + "!";
    static made() { return count; }
    constructor() { count++; }
    get label() { return tag + count; }
    describe() { return `${tag}:${count}`; }
  }
  return Local;
}
const A = make("a"), B = make("b");
new A(); new A(); new B();
log(new A().describe(), new B().describe(), A.made(), B.made(), A.kind, B.kind, new A().label, A === B);
log(new A() instanceof A, new A() instanceof B);
// extends null, conditional
class N extends null { static s() { return 1; } }
log(N.s(), Object.getPrototypeOf(N.prototype));
try { new N(); } catch (e) { log(e.name); }
const pick = (c) => c ? Base : Object;
class P extends pick(true) { x = 2; }
log(new P().n, new P().x);
class Q extends (0, Base) { y = 3; constructor() { super(); this.z = 4; } }
log(JSON.stringify(new Q()));
// checks
for (const f of [() => { class X extends 1 {} }, () => { class X extends (() => {}) {} }, () => { function F() {} F.prototype = 3; class X extends F {} }, () => { const o = {}; class X extends o {} }]) { try { f(); log("no"); } catch (e) { log(e.name); } }
// this before super, double super, return values
class D1 extends Base { constructor() { this.a = 1; super(); } }
try { new D1(); } catch (e) { log(e.name); }
class D2 extends (0, Base) { constructor() { this.a = 1; super(); } }
try { new D2(); } catch (e) { log(e.name); }
class D3 extends (0, Base) { constructor() { super(); super(); } }
try { new D3(); } catch (e) { log(e.name); }
class D4 extends (0, Base) { constructor() { super(); return { own: 1 }; } }
log(JSON.stringify(new D4()));
class D5 extends (0, Base) { constructor() { super(); return 1; } }
try { new D5(); } catch (e) { log(e.name); }
class D6 extends (0, Base) { constructor() { } }
try { new D6(); } catch (e) { log(e.name); }
try { Q(); } catch (e) { log(e.name, e.message); }
// fields, statics, accessors, computed
const k = "dyn";
function mk2(v) {
  return class K extends Object {
    [k + 1] = v;
    static [k + 2] = v * 2;
    #p = v * 3;
    static #sp = v * 4;
    get p() { return this.#p; }
    set p(x) { this.#p = x; }
    static get sp() { return K.#sp; }
    [k + 3]() { return v; }
    static { this.blk = v * 5; }
    arrow = () => this.dyn1;
    has(o) { return #p in o; }
  };
}
const K1 = mk2(1), K2 = mk2(2);
const i1 = new K1(), i2 = new K2();
log(i1.dyn1, i2.dyn1, K1.dyn2, K2.dyn2, i1.p, i2.p, K1.sp, K2.sp, i1.dyn3(), i2.dyn3(), K1.blk, K2.blk, i1.arrow(), i1.has(i1), i1.has({}));
i1.p = 9; log(i1.p, Object.keys(i1).join());
log(K1.name, K1.length, typeof K1, Object.getOwnPropertyNames(K1).join(), Object.getOwnPropertyDescriptor(K1, "prototype").writable);
log(Object.getOwnPropertyNames(K1.prototype).join(), i1.constructor === K1, Object.getPrototypeOf(K1) === Object);
