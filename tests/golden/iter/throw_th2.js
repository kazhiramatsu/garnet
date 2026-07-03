function* g() { yield 1; yield 2; }
function main() {
    const it = g();
    console.log(it.next().value); // 1
    try {
        it.throw("boom");
    }
    catch (e) {
        console.log("outer caught " + e);
    } // outer caught boom
}
main();
