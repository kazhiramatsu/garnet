class AsyncSeq {
    constructor(n) { this.i = 0; this.n = n; }
    [Symbol.asyncIterator]() { return this; }
    async next() { if (this.i < this.n) {
        const v = this.i;
        this.i = this.i + 1;
        return { value: v, done: false };
    } return { value: 0, done: true }; }
    async return() { console.log("aclosed"); return { value: 0, done: true }; }
}
async function main() {
    for await (const x of new AsyncSeq(10)) {
        console.log(x);
        if (x === 2)
            break;
    }
    console.log("end");
}
main();
