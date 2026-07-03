class A {
    constructor() { this.x = 1; return { x: 99, y: 5 }; }
}
class B {
    constructor() { this.x = 7; return 42; }
}
class C {
    constructor() { this.x = 3; }
}
class D {
    constructor() { this.x = 8; return [1, 2, 3]; }
} // array is object-like
function main() {
    const a = new A();
    console.log(a.x, a.y); // 99 5
    const b = new B();
    console.log(b.x); // 7  (primitive return ignored)
    const c = new C();
    console.log(c.x); // 3
    const d = new D();
    console.log(d.length, d[0]); // 3 1 (array return used)
}
main();
