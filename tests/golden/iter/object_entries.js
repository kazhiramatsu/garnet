class C {
    constructor() { this.a = 1; this.b = 2; }
}
function main() {
    const o = { x: 10, y: "hi", z: true };
    for (const p of Object.entries(o))
        console.log(p[0], p[1]);
    console.log(Object.entries(o).length);
    const c = new C();
    for (const p of Object.entries(c))
        console.log(p[0], p[1]);
    console.log(Object.entries({}).length);
    const sum = Object.entries({ a: 1, b: 2, c: 3 }).reduce((acc, p) => acc + p[1], 0);
    console.log(sum);
    // keys/values on class instance too
    console.log(Object.keys(c).join(","), Object.values(c).join(","));
}
main();
