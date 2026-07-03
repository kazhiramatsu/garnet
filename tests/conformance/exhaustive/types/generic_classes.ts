class Stack<T> {
  private items: T[] = [];
  push(x: T): void { this.items.push(x); }
  pop(): T | undefined { return this.items.pop(); }
  get size(): number { return this.items.length; }
  map<U>(f: (t: T) => U): Stack<U> { const s = new Stack<U>(); for (const it of this.items) s.push(f(it)); return s; }
}
class Pair<A, B> { constructor(public a: A, public b: B) {} swap(): Pair<B, A> { return new Pair(this.b, this.a); } }

function main(): void {
  const s = new Stack<number>();
  s.push(1); s.push(2); s.push(3);
  console.log(s.size, s.pop(), s.size);              // 3 3 2
  const t = s.map(x => "n" + x);
  console.log(t.pop());                              // n2
  const p = new Pair(1, "two").swap();
  console.log(p.a, p.b);                            // two 1
}
main();
