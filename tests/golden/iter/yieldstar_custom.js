class Counter {
    constructor(m) { this.i = 0; this.max = m; }
    [Symbol.iterator]() { return this; }
    next() { if (this.i < this.max) {
        const v = this.i;
        this.i = this.i + 1;
        return { value: v, done: false };
    } return { value: 0, done: true }; }
}
function* wrap() { yield 100; yield* new Counter(3); yield 200; }
function main() { let o = ""; for (const x of wrap())
    o = o + x + ","; console.log(o); }
main();
