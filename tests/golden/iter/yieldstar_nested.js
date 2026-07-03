function* a() { yield 1; yield 2; }
function* b() { yield 0; yield* a(); yield 3; }
function* c() { yield* b(); yield 4; }
function main() { let o = ""; for (const x of c())
    o = o + x + ","; console.log(o); }
main();
