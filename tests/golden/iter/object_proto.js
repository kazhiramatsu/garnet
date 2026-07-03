class Point {
    constructor() {
        this.x = 1;
    }
    toString() { return "Point!"; }
}
class Plain {
    constructor() {
        this.v = 5;
    }
}
function main() {
    const o = { a: 1 };
    console.log(o.toString());
    console.log("" + o);
    console.log(o.valueOf() === o);
    console.log("toString" in o, "valueOf" in o, "nope" in o);
    console.log(o.hasOwnProperty("a"), o.hasOwnProperty("toString"));
    const pl = new Plain();
    console.log(pl.toString(), pl.valueOf() === pl);
    const p = new Point();
    console.log(p.toString());
    console.log(Object.keys(o).join(","));
    console.log(JSON.stringify(o));
}
main();
