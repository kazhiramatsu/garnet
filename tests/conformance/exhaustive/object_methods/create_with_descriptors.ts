// Object.create(proto, descriptors): the second argument defines the properties as Object.defineProperties
// does (data and accessor descriptors, enumerability), after the prototype is set; a clone of an object by
// Object.getOwnPropertyDescriptors keeps its prototype, getters and non-enumerable members.
class Base { greet(): string { return "hi " + (this as unknown as { name: string }).name; } }
function main(): void {
  const out: string[] = [];
  const o = Object.create(Base.prototype, {
    name: { value: "zed", writable: true, enumerable: true, configurable: true },
    hidden: { value: 42, enumerable: false },
    twice: { get() { return (this as { name: string }).name + (this as { name: string }).name; }, enumerable: true },
  }) as Base & { name: string; hidden: number; twice: string };
  out.push(o.greet(), String(o.hidden), o.twice, Object.keys(o).join(","), String(o instanceof Base));
  o.name = "amy";
  out.push(o.twice, String(Object.getOwnPropertyDescriptor(o, "hidden")!.writable));
  const src = { a: 1, get b() { return this.a + 1; } };
  Object.defineProperty(src, "secret", { value: "s", enumerable: false });
  const clone = Object.create(Object.getPrototypeOf(src), Object.getOwnPropertyDescriptors(src)) as typeof src & { secret: string };
  clone.a = 10;
  out.push(String(clone.b), clone.secret, Object.keys(clone).join(","), String(src.b));
  const empty = Object.create(null, {}) as object;
  out.push(String(Object.getPrototypeOf(empty)), String(Object.keys(empty).length));
  console.log(out.join("\n"));
}
main();
