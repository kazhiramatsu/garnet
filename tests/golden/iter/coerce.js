class P {
    constructor() {
        this.x = 1;
    }
    toString() { return "P!"; }
}
class Plain {
    constructor() {
        this.v = 5;
    }
}
function main() {
    console.log(String(123), String(true), String(null), String(undefined));
    console.log(String([1, 2, 3]));
    const o = { a: 1 };
    console.log(String(o), String(new P()), String(new Plain()));
    console.log("" + new P());
    console.log(`val=${new P()}`);
    console.log(Boolean(0), Boolean(1), Boolean(""), Boolean("x"));
    console.log(Boolean(null), Boolean(undefined), Boolean(o));
    console.log(Number("42"), Number("3.14"), Number(true));
}
main();
