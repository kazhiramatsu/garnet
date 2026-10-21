// Leading stores into `this` in a class constructor or method go to the
// instance's struct fields (they used to take the literal-layout path planned
// for function-style constructors, whose sized receiver never adopts one, so
// every store took the property cache). An abstract base's constructor
// stores the fields every subclass shares; a reset method rewrites them all;
// a function-style constructor still adopts its literal layout; the values,
// the key order and undefined-initialized fields must match V8.
abstract class Base {
  readonly kind: number;
  flags: number;
  pos: number;
  end: number;
  parent: Base | undefined;
  constructor(kind: number) {
    this.kind = kind;
    this.flags = 0;
    this.pos = -1;
    this.end = -1;
    this.parent = undefined;
  }
  abstract name(): string;
}
class Leaf extends Base {
  text: string;
  constructor(text: string) { super(7); this.text = text; }
  name(): string { return `leaf:${this.text}`; }
}
class Pair extends Base {
  left: Base;
  right: Base;
  constructor(left: Base, right: Base) {
    super(9);
    this.left = left;
    this.right = right;
    left.parent = this;
    right.parent = this;
  }
  name(): string { return `(${this.left.name()} ${this.right.name()})`; }
}
class State {
  ref: Base | undefined = undefined;
  depth = 0;
  steps = 0;
  done = false;
  label: string | undefined = undefined;
  reset(ref: Base, label: string): void {
    this.ref = ref;
    this.depth = 0;
    this.steps = 0;
    this.done = false;
    this.label = label;
  }
}
function Plain(this: { a: number; b: string }, a: number, b: string) {
  this.a = a;
  this.b = b;
}
function main(): void {
  const a = new Leaf("a"), b = new Leaf("b");
  const p = new Pair(a, b);
  p.pos = 3; a.end = 5;
  console.log(p.name(), p.kind, a.kind, p.flags, a.pos, a.end, p.pos, a.parent === p, b.parent === p);
  const c = new Leaf("c");
  console.log(Object.keys(a).join(","), JSON.stringify(c));
  const s = new State();
  s.steps = 4; s.done = true;
  s.reset(p, "walk");
  console.log(s.depth, s.steps, s.done, s.label, s.ref === p, Object.keys(s).join(","));
  const free: State[] = [new State(), new State()];
  for (let i = 0; i < 3; i++) {
    const st = free.pop() ?? new State();
    st.reset(i % 2 ? a : b, "r" + i);
    st.steps = i * 2;
    console.log(st.label, st.steps, (st.ref as Leaf).text);
    free.push(st);
  }
  const q = new (Plain as unknown as new (a: number, b: string) => { a: number; b: string })(1, "x");
  console.log(q.a, q.b, Object.keys(q).join(","));
}
main();
