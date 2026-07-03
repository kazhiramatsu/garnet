function* inner() { yield 1; yield 2; }
function* outer() { yield* inner(); }
function main() {
    const g = outer();
    console.log(g.next().value); // 1
    try {
        g.throw("boom");
    }
    catch (e) {
        console.log("main caught " + e);
    } // main caught boom
}
main();
