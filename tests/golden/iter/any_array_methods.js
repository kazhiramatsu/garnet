function main() {
    const a = [10, 20, 30];
    console.log(a.join(","));
    console.log(a.indexOf(20));
    console.log(a.includes(30));
    console.log(a.slice(1).join("-"));
    console.log(a.map((x) => x * 2).join(","));
    console.log(a.filter((x) => x > 15).length);
    const b = [1, 2, 3];
    b.custom = 99;
    console.log(b.custom, b[0], b.length);
}
main();
