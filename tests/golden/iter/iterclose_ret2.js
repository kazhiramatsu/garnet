class MyRange {
    constructor(n) { this.i = 0; this.n = n; }
    [Symbol.iterator]() { return this; }
    next() {
        if (this.i < this.n) {
            const v = this.i;
            this.i = this.i + 1;
            return { value: v, done: false };
        }
        return { value: 0, done: true };
    }
    return() { console.log("closed"); return { value: 0, done: true }; }
}
function main() {
    for (const x of new MyRange(3)) {
        console.log(x);
    } // natural end -> NO "closed"
    console.log("end");
}
main();
