class A {
    constructor() {
        this.a = 1;
        this.b = 2;
    }
}
class B {
    constructor() {
        this.x = 10;
        this.y = this.x + 5;
    }
}
class C {
    constructor(n) {
        this.m = 3;
        this.n = n;
    }
}
class Base {
    constructor() {
        this.p = 100;
        this.p = this.p + 1;
    }
}
class Derived extends Base {
    constructor() {
        super();
        this.q = 200;
        this.q = this.q + 2;
    }
}
class D2 extends Base {
    constructor() {
        super(...arguments);
        this.r = 5;
    }
}
function main() {
    const a = new A();
    console.log(a.a, a.b);
    const b = new B();
    console.log(b.x, b.y);
    const c = new C(7);
    console.log(c.n, c.m);
    const d = new Derived();
    console.log(d.p, d.q);
    const d2 = new D2();
    console.log(d2.p, d2.r);
}
main();
