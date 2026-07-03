class Builder {
  private parts: string[] = [];
  add(s: string): this { this.parts.push(s); return this; }
  build(): string { return this.parts.join("-"); }
}
class TaggedBuilder extends Builder {
  tag(t: string): this { return this.add("#" + t); }
}
class Box<T> { constructor(protected v: T) {} get(): T { return this.v; } self(): this { return this; } }

function main(): void {
  console.log(new Builder().add("a").add("b").add("c").build());      // a-b-c
  console.log(new TaggedBuilder().add("x").tag("y").add("z").build()); // x-#y-z
  const b = new Box(5);
  console.log(b.self().self().get());                                  // 5
}
main();
