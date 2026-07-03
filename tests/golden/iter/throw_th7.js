async function* inner() {
    try {
        yield 10;
        yield 20;
    }
    catch (e) {
        console.log("inner caught " + e);
        yield 30;
    }
}
async function* outer() { yield* inner(); }
async function main() {
    const g = outer();
    const r1 = await g.next();
    console.log(r1.value); // 10
    const r2 = await g.throw("X");
    console.log(r2.value); // inner caught X, 30
}
main();
