function* inner() { yield 1; yield 2; yield 3; }
function* outer() { yield 0; yield* inner(); yield 4; }
function main() { let o = ""; for (const x of outer())
    o = o + x + ","; console.log(o); }
main();
