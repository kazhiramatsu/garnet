class MyRange {
    constructor(n) { this.i = 0; this.n = n; }
    [Symbol.iterator]() { return this; }
    next() { if (this.i < this.n) {
        const v = this.i;
        this.i = this.i + 1;
        return { value: v, done: false };
    } return { value: 0, done: true }; }
}
function main() { let s = 0; for (const x of new MyRange(5))
    s = s + x; console.log(s); }
main();
