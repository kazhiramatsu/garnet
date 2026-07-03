function* g() {
    try {
        yield 1;
        yield 2;
    }
    catch (e) {
        console.log("caught " + e);
        yield 99;
    }
}
function main() {
    const it = g();
    console.log(it.next().value); // 1
    console.log(it.throw("boom").value); // caught boom, then 99
}
main();
