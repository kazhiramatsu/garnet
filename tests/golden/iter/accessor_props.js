function main() {
    const o = {};
    let _v = 0;
    Object.defineProperty(o, "x", { get: () => _v, set: (val) => { _v = val * 2; } });
    console.log(o.x);
    o.x = 5;
    console.log(o.x);
    const g = {};
    Object.defineProperty(g, "ro", { get: () => 42 });
    console.log(g.ro);
    const t = { base: 100 };
    Object.defineProperty(t, "doubled", { get: function () { return this.base * 2; } });
    console.log(t.doubled);
    const e = { a: 1 };
    Object.defineProperty(e, "hidden", { get: () => 7 });
    console.log(Object.keys(e).join(","));
    console.log(JSON.stringify(e));
}
main();
