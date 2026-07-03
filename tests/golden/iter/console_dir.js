function main() {
    console.dir({ a: 1, b: "two" });
    console.log([1, [2, 3]]);
    const m = new Map();
    m.set("k", 5);
    console.log(m);
    const s = new Set();
    s.add(1);
    s.add(2);
    console.log(s);
    console.dir([{ x: 1 }, { y: 2 }]);
}
main();
