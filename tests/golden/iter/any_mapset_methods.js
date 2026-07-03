function main() {
    const m = new Map();
    m.set("a", 1);
    m.set("b", 2);
    console.log(m.get("a"), m.get("b"));
    console.log(m.has("a"), m.has("z"));
    m.delete("a");
    console.log(m.has("a"));
    let sum = 0;
    m.forEach((v) => { sum = sum + v; });
    console.log(sum);
    const s = new Set();
    s.add(5);
    s.add(7);
    s.add(5);
    console.log(s.has(5), s.has(9));
    s.delete(5);
    console.log(s.has(5));
    let t = 0;
    s.forEach((v) => { t = t + v; });
    console.log(t);
}
main();
