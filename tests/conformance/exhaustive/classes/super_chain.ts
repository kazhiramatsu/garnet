// @ts-nocheck
// @oracle esnext
// `super.x` reads and writes through the chain, `this` the receiver: what a class's parents do not declare is
// found on the prototypes (it read undefined, silently), a refused store is a TypeError, a reference to `super`
// ahead of super() a ReferenceError. Typed array bases.
const log = (...a: any[]) => console.log(...a);
const name = (f: () => unknown) => { try { return f(); } catch (e: any) { return e.name; } };

class A {} class B extends A {}
class C extends B { read() { return [super.fromA, super.fromB, super.none]; } }
(A.prototype as any).fromA = "a"; (A.prototype as any).fromB = "a"; (B.prototype as any).fromB = "b";
(C.prototype as any).fromA = "c"; (C.prototype as any).fromB = "c";
log(new C().read());

class S { static sx = 1; } (S as any).added = 2;
class T extends S { static read() { return [super.sx, super.added, super.none]; } }
log(T.read());
class Base { m() { return super.toString === Object.prototype.toString; } }
log(new Base().m());

class Frozen { method() { super.x = 8; const a = Object.keys(this).join(); Object.freeze(this); return [a, name(() => { super.y = 9; })]; } }
log(new Frozen().method(), Object.keys(Frozen.prototype));
const lit = { method() { Object.freeze(this); return name(() => { super.y = 9; }); } };
log(lit.method());
class Comp { method() { Object.freeze(this); return name(() => { super["y"] = 9; }); } }
log(new Comp().method());
class Getter { get g() { return 1; } } class Sub extends Getter { w() { return name(() => { super.g = 2; }); } }
log(new Sub().w());
class Setter { set s(v: number) { (this as any).got = v; } } class Sub2 extends Setter { w() { super.s = 3; return (this as any).got; } }
log(new Sub2().w());

class P { constructor() { log("parent"); } }
class D1 extends P { constructor() { let r; try { super.x; } catch (e: any) { r = e.name; } log(r); super(); } }
new D1();
class D2 extends P { constructor() { let r; try { super["x"]; } catch (e: any) { r = e.name; } log(r); super(); } }
new D2();
class D3 extends P { constructor() { let r; try { super.x = 1; } catch (e: any) { r = e.name; } log(r); super(); } }
new D3();

let order = "";
function arg() { order += "arg"; return 1; }
const o: any = {};
log(name(() => o.bar.gar(arg())), order);
let k: any = "MAX_VALUE"; log(k in (k = "none", Number), k);
var ctor: any = function (this: any) { this.foo = 42; };
log(new ctor(ctor = 1).foo, ctor);
log(name(() => new (undefined as any)()), name(() => { const u: any = undefined; return new u(); }));

for (const T of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) {
  const X = class extends (T as any) { twice() { return this[0] * 2; } } as any;
  const v = new X(2); v[0] = 21;
  log(v instanceof X, v instanceof T, v.length, v.twice(), Object.getPrototypeOf(X) === T);
}
class Bytes extends Uint8Array { first() { return this[0]; } }
const by = new Bytes([7, 8]); log(by.first(), by.length, by instanceof Uint8Array, Array.from(by));
class Buf extends ArrayBuffer { size() { return this.byteLength; } }
log(new Buf(8).size(), new Buf(8) instanceof ArrayBuffer);
class SBuf extends SharedArrayBuffer {}
log(new SBuf(4).byteLength);
const V: any = Uint16Array; log(new V(3).length, name(() => V(3)));
const AB: any = ArrayBuffer; log(new AB(5).byteLength, name(() => AB(5)));
