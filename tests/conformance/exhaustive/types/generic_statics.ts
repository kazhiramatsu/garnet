class Container<T> {
  private constructor(public value: T) {}
  static of<U>(v: U): Container<U> { return new Container(v); }
  static empty<U>(): Container<U | null> { return new Container<U | null>(null); }
  static pair<U>(a: U, b: U): [Container<U>, Container<U>] { return [new Container(a), new Container(b)]; }
  map<U>(f: (t: T) => U): Container<U> { return Container.of(f(this.value)); }
}
class Counter {
  static count = 0;
  static next<T>(v: T): { id: number; v: T } { return { id: ++Counter.count, v }; }
}
function main(): void {
  console.log(Container.of(5).map(x => x + 1).value);          // 6
  console.log(Container.empty<number>().value);                // null
  console.log(Container.of("a").map(s => s + "b").map(s => s.length).value); // 2
  const [p, q] = Container.pair(10, 20);
  console.log(p.value + q.value);                              // 30
  console.log(Counter.next("x").id, Counter.next("y").id, Counter.count);    // 1 2 2
}
main();
