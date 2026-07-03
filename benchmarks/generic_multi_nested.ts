class Pair<A, B> { a: A; b: B; constructor(a: A, b: B) { this.a = a; this.b = b; } first(): A { return this.a; } second(): B { return this.b; } }
class Box<T> { value: T; constructor(v: T) { this.value = v; } get(): T { return this.value; } }
function main(): void {
  const p = new Pair<number, number>(3, 4);
  console.log(p.first() + p.second());        // 7
  const nested = new Box<Box<number>>(new Box<number>(99));
  console.log(nested.get().get());            // 99
  const ps = new Pair<string, number>("x", 5);
  console.log(ps.second());                   // 5
}

main();
