// @oracle esnext
// @ts-nocheck
class A { #x = 1; getX() { return this.#x; } static read(o) { return o.#x; } static has(o) { return #x in o; } setX(v) { this.#x = v; } }
class B extends A { #x = 2; getB() { return this.#x; } }
const b = new B();
console.log(b.getX(), b.getB());
b.setX(5); console.log(b.getX(), b.getB());
const t = (f) => { try { console.log("ok", f()); } catch (e) { console.log(e.name, e.constructor === TypeError); } };
t(() => A.read({}));
t(() => A.read(Object.create(new A())));
t(() => A.has({}));
t(() => A.has(new A()));
t(() => new A().setX.call({}, 1));
t(() => A.has(1));
class M { #m() { return 1; } get #g() { return 2; } set #s(v) { this.v = v; } static #sm() { return 3; } static call(o) { return o.#m(); } static getg(o) { return o.#g; } static wr(o) { o.#m = 1; } static wg(o) { o.#g = 1; } static rs(o) { return o.#s; } static sm() { return this.#sm(); } static ws(o, v) { o.#s = v; return o.v; } static name2() { return new M().#m.name; } }
class N extends M {}
t(() => M.call(new M()));
t(() => M.call(new N()));
t(() => M.call({}));
t(() => M.call(M.prototype));
t(() => M.getg(new M()));
t(() => M.wr(new M()));
t(() => M.wg(new M()));
t(() => M.rs(new M()));
t(() => M.sm());
t(() => N.sm());
t(() => M.ws(new M(), 4));
t(() => M.name2());
console.log(Object.getOwnPropertyNames(new A()).join(), Object.getOwnPropertyNames(M).join(), Object.getOwnPropertyNames(M.prototype).join());
console.log(Object.prototype.hasOwnProperty.call(new A(), "#x"), "#x" in new A(), new A()["#x"]);
class Sf { static #c = 0; static inc() { return ++Sf.#c; } static viaThis() { return this.#c; } }
class Sg extends Sf {}
console.log(Sf.inc(), Sf.inc(), Sf.viaThis());
t(() => Sg.viaThis());

// compound forms, the target once
var n = 0;
class P { #f = 1; get #g() { return this.#f; } set #g(v) { this.#f = v; } static #sf = 1; static get #sg() { return P.#sf; } static set #sg(v) { P.#sf = v; }
  o() { n++; return this; }
  run() {
    this.o().#f += 1; console.log(this.#f, n);
    this.o().#f++; console.log(this.#f, n);
    this.o().#g *= 3; console.log(this.#g, n);
    this.o().#g--; console.log(this.#g, n);
    this.o().#f ||= 9; this.o().#f &&= 7; console.log(this.#f, n);
    this.#f = 0; this.o().#g ??= 5; this.o().#f ||= 6; console.log(this.#f, n);
    [this.#f, this.#g] = [10, 20]; console.log(this.#f);
    ({ a: this.#f, b: this.#g = 30 } = { a: 1 }); console.log(this.#f);
    for (this.#f of [1, 2]) ; console.log(this.#f);
    console.log((this).#f);
  }
  static srun() { P.#sf += 2; P.#sg *= 2; P.#sf++; console.log(P.#sf, P.#sg); }
}
new P().run(); P.srun();
class Q { #fn = function () { return this; }; #arrow = () => 1; call() { return [this.#fn() === this, this.#arrow(), this.#fn`x` === this]; } }
console.log(new Q().call());
class R { #m() { return this; } m2() { return this.#m() === this; } v() { return this.#m === this.#m; } }
console.log(new R().m2(), new R().v());
class S1 { static #v = 1; static m() { return class { static r() { return S1.#v; } }; } }
console.log(S1.m().r());
class T1 { #a = 1; inner() { const self = this; return function () { return self.#a; }; } nest() { class In { #a = 2; read(o) { return [this.#a, o.#a]; } } return new In().read(new In()); } }
console.log(new T1().inner()(), new T1().nest());
class U { #x; constructor(x) { this.#x = x; } equals(o) { return #x in o && this.#x === o.#x; } }
console.log(new U(1).equals(new U(1)), new U(1).equals({}), new U(1).equals(new U(2)));
console.log(JSON.stringify(new U(1)), Object.keys(new U(1)), new U(1));
const fz = Object.freeze(new U(1)); console.log(fz.equals(new U(1)));
class Str { "#a" = 1; } console.log(Object.keys(new Str()), new Str()["#a"]);

// a private method whose locals are captured: the scope record is named after it
class ScopedPrivate {
  #m() { let a = 1; let b = 2; const f = () => a + b; const g = () => { a += 1; b += 1; }; g(); return f(); }
  run() { return this.#m(); }
}
console.log(new ScopedPrivate().run());
