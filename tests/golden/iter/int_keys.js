function main() {
    const a = {};
    a["0"] = 1;
    a[0] = 2; // same key -> {"0":2}
    console.log(a[0], a["0"]);
    console.log(JSON.stringify(a), Object.keys(a).length);
    const b = {};
    b[1.0] = 10;
    b[1.5] = 20;
    b["01"] = 30; // 1.0->"1", 1.5->"1.5", "01" string
    console.log(b[1], b[1.5], b["01"]);
    console.log(Object.keys(b).join(","));
    const c = {};
    c[2] = "c";
    c["name"] = "x";
    c[0] = "a";
    c[1] = "b"; // int keys first, ascending
    console.log(JSON.stringify(c));
    console.log(Object.keys(c).join(","), Object.values(c).join(","));
    const s = "hello";
    console.log(s[0], s[4]); // char access
}
main();
