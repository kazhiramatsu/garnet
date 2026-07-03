function* inner() { yield 1; yield 2; return 99; }
function* outer() { const r = yield* inner(); yield r; }
function main() { let o = ""; for (const x of outer())
    o = o + x + ","; console.log(o); }
main();
