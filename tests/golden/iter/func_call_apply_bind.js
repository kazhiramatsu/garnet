function f(a, b) {
    const base = (this && this.base) ? this.base : 0;
    return base + a + b;
}
function add(a, b) { return a + b; }
function greet(name) {
    return (this && this.prefix ? this.prefix : "Hi ") + name;
}
function main() {
    const ctx = { base: 100 };
    console.log(f.call(ctx, 1, 2)); // 103
    console.log(f.apply(ctx, [3, 4])); // 107
    const g = f.bind(ctx, 10);
    console.log(g(5)); // 115
    const h = f.bind(ctx);
    console.log(h(20, 30)); // 150
    console.log(f(1, 2)); // 3 (direct, this undefined)
    const fv = f;
    console.log(fv(4, 5)); // 9 (value call)
    console.log(add.call(null, 3, 4)); // 7 (free fn ignores thisArg)
    const add10 = add.bind(null, 10);
    console.log(add10(5)); // 15
    const o = { prefix: "Hello " };
    console.log(greet.bind(o)("World")); // Hello World
}
main();
