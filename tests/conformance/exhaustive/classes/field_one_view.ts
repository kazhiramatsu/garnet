// One field, two static types: a class and its subclass, or a class and an interface. Every access goes
// through the struct of the class declaring the field (docs/pic_sized_inline_design.md, "One struct per
// field"): through the receiver's class, the C compiler's alias analysis took the two accesses for
// two objects, and a load kept the value from before the store, with no error. The calls go through
// values so that each function's two parameters stay two pointers.
class Base {
  x = 1.5;
  tag = "base";
}
class Sub extends Base {
  y = 2;
}
class Leaf extends Sub {
  z = 0.25;
}

function numberThroughBase(o: Sub, b: Base): number {
  o.x = 1.5;
  b.x = 2.5;
  return o.x;
}
function numberThroughSub(o: Sub, b: Base): number {
  b.x = 3.5;
  o.x = 4.5;
  return b.x;
}
function threeViews(l: Leaf, s: Sub, b: Base): number {
  l.x = 1.25;
  s.x = l.x + 1;
  b.x = s.x + 1;
  return l.x + s.x + b.x;
}
function boxedThroughBase(o: Sub, b: Base): string {
  o.tag = "sub";
  b.tag = "changed";
  return o.tag;
}
function ownAndInherited(o: Sub, b: Base): number {
  o.y = 8;
  b.x = 16;
  return o.y + o.x;
}

const nb = numberThroughBase;
const ns = [numberThroughSub][0];
const tv = threeViews;
const bb = boxedThroughBase;
const oi = [ownAndInherited][0];
const s = new Sub();
const l = new Leaf();
console.log(nb(s, s), ns(s, s), tv(l, l, l), bb(s, s), oi(s, s));

// a method's `this` against a parameter of the base type
class Counter {
  count = 0.5;
  name = "c";
}
class NamedCounter extends Counter {
  label = "n";
  addTwice(other: Counter): number {
    const before = this.count;
    other.count = before + 1;
    const after = this.count;
    other.count = after + 1;
    return this.count - before;
  }
}
const nc = new NamedCounter();
const add = (o: NamedCounter, c: Counter): number => o.addTwice(c);
console.log(add(nc, nc), add(nc, nc), nc.count);

// an interface-typed site, which tests the class declaring the field, against a class-typed one
interface Slot {
  value: number;
  text: string;
}
class Cell implements Slot {
  value = 1.5;
  text = "t";
}
class NamedCell extends Cell {
  name = "n";
}
class OtherCell implements Slot {
  pad = "p";
  text = "o";
  value = 0.5;
}
function bump(c: NamedCell, h: Slot): number {
  const before = c.value;
  h.value = before + 1;
  const after = c.value;
  return after - before + h.value;
}
function retext(c: NamedCell, h: Slot): string {
  const before = c.text;
  h.text = before + "!";
  const after = c.text;
  return before + after + h.text;
}
function readThroughSlot(c: Cell, h: Slot): number {
  c.value = 7.5;
  const a = h.value;
  c.value = 8.5;
  return a + h.value;
}
const b1 = bump;
const r1 = [retext][0];
const rs = readThroughSlot;
const n = new NamedCell();
console.log(b1(n, n), b1(n, n), n.value, r1(n, n), r1(n, n), rs(n, n));
const slots: Slot[] = [new Cell(), new NamedCell(), new OtherCell()];
console.log(slots.map((h) => { h.value = h.value * 2; h.text += "+"; return h.value + h.text; }).join(","));

// the allocation's own stores of an inherited field, then a read through the declaring class
class Plain {
  u: string | undefined;
  w = 1;
}
class Over extends Plain {
  v = "own";
}
function fresh(): Plain {
  return new Over();
}
const fr = [fresh][0];
console.log(fr().u, fr().w, (fr() as Over).v);

// integer slots through an interface: an enum-typed field and a counter whose stores are all integers
enum Flag {
  A = 1,
  B = 2,
  C = 4,
}
interface Effect {
  flags: Flag;
  runs: number;
}
class Render implements Effect {
  flags = Flag.A;
  runs = 0;
}
class Computed implements Effect {
  deps = "d";
  runs = 10;
  flags = Flag.B;
}
function step(e: Effect, rounds: number): void {
  for (let i = 0; i < rounds; i++) {
    e.flags |= Flag.C;
    e.flags &= ~Flag.A;
    e.runs = e.runs + 1;
  }
}
const re = new Render();
const co = new Computed();
step(re, 3);
step(co, 5);
console.log(re.flags, re.runs, co.flags, co.runs);
