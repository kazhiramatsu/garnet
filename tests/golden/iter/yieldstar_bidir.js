function* inner() { const a = yield 1; const b = yield a + 1; return b; }
function* outer() { yield* inner(); }
function main() {
    const g = outer();
    console.log(g.next().value);
    console.log(g.next(10).value);
    console.log(g.next(20).done ? "done" : "more");
}
main();
