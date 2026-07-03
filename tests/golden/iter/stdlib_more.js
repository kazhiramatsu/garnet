function main() {
    console.log([1, [2, [3]]].flat());
    console.log([1, 2].flatMap((x) => [x, -x]));
    console.log([5, 3, 8, 1].findLast((x) => x < 5));
    const o = Object.assign({ a: 1 }, { b: 2 });
    console.log(o.a, o.b);
    console.log(Object.fromEntries([["x", 9]]).x);
    console.log(Math.clz32(1), Math.fround(2.5));
    console.log(String.fromCharCode(65, 66));
    console.log(Array.isArray([]), Array.of(7, 8));
}
main();
