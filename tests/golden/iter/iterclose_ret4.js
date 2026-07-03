class NoRet {
    constructor(n) { this.i = 0; this.n = n; }
    [Symbol.iterator]() { return this; }
    next() { if (this.i < this.n) {
        const v = this.i;
        this.i = this.i + 1;
        return { value: v, done: false };
    } return { value: 0, done: true }; }
}
function main() {
    for (const x of new NoRet(10)) {
        console.log(x);
        if (x === 1)
            break;
    }
    console.log("end");
}
main();
