class Box {
    constructor(v) { this.v = v; }
    get() { return this.v; }
}
let g = null;
function make(n) {
    const b = new Box(n); // ESCAPES via return -> no SROA
    return b;
}
function main() {
    const b = make(42);
    console.log(b.get());
    // also a non-escaping one in the same function -> SROA eligible
    const local = new Box(7);
    console.log(local.get());
}
main();
