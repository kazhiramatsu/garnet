async function* g() {
    try {
        yield 1;
        yield 2;
    }
    catch (e) {
        console.log("ag caught " + e);
        yield 99;
    }
}
async function main() {
    const it = g();
    const r1 = await it.next();
    console.log(r1.value); // 1
    const r2 = await it.throw("boom");
    console.log(r2.value); // ag caught boom, 99
}
main();
