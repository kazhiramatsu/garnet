class Box<T> {
  value: T;
  constructor(v: T) { this.value = v; }
  get(): T { return this.value; }
}
function identity<T>(x: T): T { return x; }
function main(): void {
  const b = new Box<number>(42);
  console.log(b.get(), identity(7), identity("hi"));
}

main();
