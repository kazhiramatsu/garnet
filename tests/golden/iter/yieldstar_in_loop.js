function* pair(x) { yield x; yield x * 10; }
function* outer() { for (let i = 1; i <= 3; i++)
    yield* pair(i); }
function main() { let o = ""; for (const x of outer())
    o = o + x + ","; console.log(o); }
main();
