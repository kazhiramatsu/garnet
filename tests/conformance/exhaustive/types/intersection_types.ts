interface HasName { name: string; }
interface HasAge { age: number; }
type Person = HasName & HasAge;
function merge<A, B>(a: A, b: B): A & B { return { ...a, ...b }; }
function greet(p: HasName & { greeting: string }): string { return p.greeting + ", " + p.name; }
function main(): void {
  const p: Person = { name: "Ann", age: 30 };
  console.log(p.name, p.age);                       // Ann 30
  const m = merge({ x: 1 }, { y: 2 });
  console.log(m.x + m.y);                           // 3
  const both = merge({ name: "Bob" }, { age: 25, greeting: "Hi" });
  console.log(greet(both), both.age);              // Hi, Bob 25
}
main();
