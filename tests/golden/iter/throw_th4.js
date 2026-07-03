function* inner() {
    try {
        yield 1;
        yield 2;
    }
    catch (e) {
        console.log("inner caught " + e);
        yield 99;
    }
}
function* outer() { yield* inner(); }
function main() {
    const g = outer();
    console.log(g.next().value); // 1
    console.log(g.throw("boom").value); // inner caught boom, 99
}
main();
