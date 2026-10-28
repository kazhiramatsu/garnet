// A receiver typed as a class the structural flow pass made unstable (an `any` typed as it) takes
// the class hint with the interval guard (Session 356, docs/hidden_class_design.md S0): a sized
// instance of the class or a subclass reads the struct slot, anything else the generic path — a
// plain object, an instance of another class, a relinked instance, a frozen instance's writes,
// null and undefined (a TypeError), an instance with an own dynamic property.
class Vertex { x = 1; y = 2; tag = "n"; }
class Leaf extends Vertex { z = 3; }
class Other { x = 100; y = 200; tag = "o"; }
const bag = new Map();                       // Map<any, any>: the values flow into Vertex-typed bindings
function pick(k: string): Vertex { return bag.get(k); }
function sumXY(n: Vertex) { return n.x + n.y; }
function setX(n: Vertex, v: number) { n.x = v; return n.x; }
function tagOf(n: Vertex) { return n.tag; }
function main() {
  const out: string[] = [];
  bag.set("n", new Vertex()); bag.set("l", new Leaf()); bag.set("o", new Other());
  bag.set("p", { x: 10, y: 20, tag: "p" }); bag.set("q", { tag: "q" });
  for (const k of ["n", "l", "o", "p", "q"]) {
    const n = pick(k);
    out.push(k + ":" + sumXY(n) + ":" + tagOf(n) + ":" + setX(n, 5) + ":" + sumXY(n));
  }
  const r: any = new Vertex(); Object.setPrototypeOf(r, Other.prototype); bag.set("r", r);
  out.push("r:" + sumXY(pick("r")) + ":" + tagOf(pick("r")) + ":" + setX(pick("r"), 9));
  const f = new Vertex(); Object.freeze(f); bag.set("f", f);
  try { setX(pick("f"), 7); out.push("f:no-throw:" + sumXY(f)); } catch (e) { out.push("f:" + (e instanceof TypeError) + ":" + sumXY(f)); }
  for (const k of ["missing", "nul"]) {
    bag.set("nul", null);
    try { out.push(k + ":" + sumXY(pick(k))); } catch (e) { out.push(k + ":" + (e instanceof TypeError)); }
  }
  const sub: any = new Leaf(); sub.extra = 1; bag.set("sub", sub);      // an own dynamic property on an instance
  out.push("sub:" + sumXY(pick("sub")) + ":" + tagOf(pick("sub")) + ":" + setX(pick("sub"), 8));
  console.log(out.join("\n"));
}
main();
