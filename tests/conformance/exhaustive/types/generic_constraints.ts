function longest<T extends { length: number }>(a: T, b: T): T {
  return a.length >= b.length ? a : b;
}
function prop<T, K extends keyof T>(obj: T, key: K): T[K] { return obj[key]; }
function makePair<T = number>(a: T, b: T): [T, T] { return [a, b]; }
class Box<T> { constructor(public value: T) {} map<U>(f: (t: T) => U): Box<U> { return new Box(f(this.value)); } }

function main(): void {
  console.log(longest("aaa", "bb"));                    // aaa
  console.log(longest([1, 2], [3, 4, 5]).length);       // 3
  const o = { a: 1, b: "two", c: true };
  console.log(prop(o, "a"), prop(o, "b"), prop(o, "c")); // 1 two true
  const p = makePair(3, 4); console.log(p[0] + p[1]);    // 7
  const b = new Box(10).map((x) => x * 2).map((x) => "v" + x);
  console.log(b.value);                                  // v20
}
main();
