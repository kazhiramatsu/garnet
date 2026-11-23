// What a function returns is an integer for its callers only where every return is one, whatever calls it
// (docs/int32_fields_design.md, "Integer returns"): a method's result stored in a number field keeps the
// field an integer slot only then. Each case here is one a proof could get wrong: a parameter returned
// with an integer at one call and a fraction at another, a fraction at the end of a recursion, one
// fractional override among the classes a call can reach, negative zero out of a product, a value past
// 2^53, a result out of a `finally`, a function called through a value, and what `Atomics` returns.
class Cursor {
  pos = 0;
  mark = 0;
  ratio = 0;
  constructor(public text: string, public step: number) {}
  // every return an integer
  lineEnd(from: number): number {
    const at = this.text.indexOf("\n", from);
    return at < 0 ? this.text.length : at | 0;
  }
  // a parameter comes back: an integer only if every caller passes one
  same(x: number): number {
    return x;
  }
  half(x: number): number {
    return x / 2;
  }
  // an integer field's load, and a sum of two
  where(): number {
    return this.pos + this.mark;
  }
  advance(): number {
    this.pos = this.lineEnd(this.pos + 1);
    this.mark = this.same(this.pos) + 1;
    this.ratio = this.same(this.step);   // step is 2.5 for one cursor
    return this.where();
  }
}

function depth(n: number): number {
  return n <= 0 ? 0 : 1 + depth(n - 1);
}
function slope(n: number): number {
  return n <= 0 ? 0.5 : slope(n - 1) + 1;   // a fraction at the end of the recursion
}
function even(n: number): number {
  return n <= 0 ? 0 : odd(n - 1) + 1;
}
function odd(n: number): number {
  return n <= 0 ? 0.25 : even(n - 1) + 1;   // one fractional leaf in a cycle of two
}

abstract class Shape {
  abstract size(): number;
}
class Square extends Shape {
  constructor(public side: number) {
    super();
  }
  size(): number {
    return this.side * this.side | 0;
  }
}
class Circle extends Shape {
  constructor(public r: number) {
    super();
  }
  size(): number {
    return 3.25 * this.r;   // one override with a fraction
  }
}
class Box {
  total = 0;
  last = 0;
  add(s: Shape): void {
    this.last = s.size();
    this.total += this.last;
  }
}

function product(a: number, b: number): number {
  return a * b;
}
function huge(a: number): number {
  return a * 4096 * 4096 * 4096 * 4096 + 1;
}
function guarded(n: number): number {
  try {
    if (n > 2) throw new Error("x");
    return n | 0;
  } catch {
    return n + 0.5;
  } finally {
    n = 0;
  }
}
class Holder {
  zero = 0;
  big = 0;
  g = 0;
  id = 0;
  seen = 0;
}

function main(): void {
  const text = "ab\ncde\n\nfghij";
  const a = new Cursor(text, 3);
  const b = new Cursor(text, 2.5);
  const out: string[] = [];
  for (let i = 0; i < 4; i++) out.push(String(a.advance()), String(b.advance()));
  out.push(String(a.pos), String(a.mark), String(a.ratio), String(b.ratio), String(a.half(a.pos)), String(b.same(0.75)));
  console.log(out.join(" "));

  console.log(depth(7), slope(3), even(4), odd(4), even(5));

  const box = new Box();
  const shapes: Shape[] = [new Square(3), new Circle(2), new Square(4.9)];
  for (const s of shapes) box.add(s);
  console.log(box.total, box.last);

  const h = new Holder();
  h.zero = product(0, -3);
  h.big = huge(3);
  h.g = guarded(1);
  console.log(Object.is(h.zero, -0), 1 / h.zero, h.big, h.big % 2, h.g);
  h.g = guarded(7);
  console.log(h.g);

  // through a value: nothing is known of the callers
  const fns: ((x: number) => number)[] = [(x) => x | 0, (x) => x / 4, depth];
  let through = 0;
  for (const f of fns) through += f(6);
  console.log(through);

  // Atomics on integer arrays: the element as a number
  const ints = new Int32Array(new SharedArrayBuffer(16));
  const units = new Uint32Array(new SharedArrayBuffer(8));
  h.id = Atomics.add(ints, 0, 5);
  h.id += Atomics.add(ints, 0, 7);
  h.seen = Atomics.load(ints, 0) + Atomics.exchange(ints, 1, 9) + Atomics.compareExchange(ints, 1, 9, -4);
  Atomics.store(units, 0, 4294967295);
  const top = Atomics.sub(units, 0, 1);
  const low = Atomics.or(ints, 2, -2147483648) + Atomics.and(ints, 2, 3) + Atomics.xor(ints, 3, 6);
  console.log(h.id, h.seen, Atomics.load(ints, 1), top, Atomics.load(units, 0), low, Atomics.load(ints, 2));
}
main();
