// Methods that are one known closure program-wide: the call site guesses the
// callee and guards the guess with the closure's code pointer. Two instances
// with different environments, a member reading `this`, other functions
// installed under the same key through dynamic routes (computed-key stores,
// defineProperty, Reflect.set, bind, a builtin, a Proxy, an accessor),
// replacement after the first call, a missing member, call/apply, extra
// arguments.
interface Factory { tag: string; make(n: number): string; count(): number; describe(this: Factory, extra?: string): string; }
function createFactory(tag: string, base: number): Factory {
  let made = 0;
  function make(n: number): string { made++; return tag + ":" + (base + n); }
  function count(): number { return made; }
  function describe(this: Factory, extra?: string): string { return this.tag + "/" + (extra ?? "-") + "/" + this.count(); }
  return { tag, make, count, describe };
}
function useFactory(f: Factory, n: number): string {
  return f.make(n) + " " + f.make(n * 2) + " " + f.count() + " " + f.describe() + " " + f.describe("x");
}
function install(target: Record<string, unknown>, key: string, value: unknown): void { target[key] = value; }
function main(): void {
  const a = createFactory("a", 10);
  const b = createFactory("b", 100);
  console.log(useFactory(a, 1));
  console.log(useFactory(b, 2));
  console.log(useFactory(a, 3));
  // other functions under the same keys, installed without a literal
  const other: Record<string, unknown> = { tag: "o" };
  install(other, "make", (n: number) => "other" + n);
  install(other, "count", () => -1);
  install(other, "describe", function (this: Factory) { return "od" + this.tag; });
  console.log(useFactory(other as unknown as Factory, 4));
  const bound: Record<string, unknown> = { tag: "bd" };
  Object.defineProperty(bound, "make", { value: a.make.bind(b), writable: true, configurable: true });
  Reflect.set(bound, "count", b.count);
  install(bound, "describe", a.describe);
  console.log(useFactory(bound as unknown as Factory, 5));
  const builtin: Record<string, unknown> = { tag: "bi" };
  install(builtin, "make", Math.abs);
  install(builtin, "count", Date.now.bind(null));
  install(builtin, "describe", () => "bid");
  const bi = builtin as unknown as Factory;
  console.log(bi.make(-6), bi.count() > 0, bi.describe());
  // replacing a member after the first call
  const c = createFactory("c", 1000);
  console.log(c.make(1));
  install(c as unknown as Record<string, unknown>, "make", (n: number) => "replaced" + n);
  console.log(c.make(2), c.count());
  // a Proxy whose get trap substitutes the member
  const p = new Proxy(createFactory("p", 5), { get(t, k, r) { return k === "make" ? (n: number) => "proxied" + n : Reflect.get(t, k, r); } });
  console.log(useFactory(p, 6));
  // an accessor under the key
  const acc: Record<string, unknown> = { tag: "acc" };
  Object.defineProperty(acc, "make", { get() { return (n: number) => "acc" + n; } });
  install(acc, "count", () => 7);
  install(acc, "describe", () => "accd");
  console.log(useFactory(acc as unknown as Factory, 7));
  // a missing member and a non-callable member
  const missing = { tag: "m", count: () => 0 } as unknown as Factory;
  try { missing.make(1); } catch (e) { console.log(e instanceof TypeError); }
  const notFn: Record<string, unknown> = { tag: "n" };
  install(notFn, "make", 42);
  try { (notFn as unknown as Factory).make(1); } catch (e) { console.log(e instanceof TypeError); }
  // call/apply and extra arguments
  console.log(a.make.call(b, 8), a.make.apply(a, [9]), (a.make as any)(1, 2, 3));
  console.log(a.count(), b.count(), c.count());
}
main();
