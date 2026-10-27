// fn.call(thisArg, ...args) and fn.apply(thisArg, array) on function-typed values (rxjs's
// `project.call(thisArg, value, index)`): a function expression reading `this`, an arrow (its `this` is
// lexical), a method taken off an object, a static method with a class as `this`, a bound function, a
// builtin function value (Math.max.apply), fewer and more arguments than parameters, no arguments, an
// undefined thisArg, apply with an empty array and with array-likes, and a non-callable receiver
// throwing the TypeError both engines raise.
interface Ctx { base: number }
class K {
  constructor(public v: number) {}
  get(): number { return this.v; }
  static tag(this: typeof K, s: string): string { return this.name + ":" + s; }
}
function main(): void {
  const out: string[] = [];
  const add = function (this: Ctx, a: number, b: number): number { return this.base + a + b; };
  const arrow = (a: number, b: number): number => a * b;
  const ctx: Ctx = { base: 100 };
  let idx = 0;
  const project = (value: number, index: number): number => value * 10 + index;
  out.push(String(add.call(ctx, 1, 2)), String(add.apply(ctx, [3, 4])), String(arrow.call(ctx, 5, 6)), String(arrow.apply(null, [7, 8])));
  out.push(String(project.call(undefined, 4, idx++)), String(project.call(ctx, 5, idx++)), String(idx));
  const k = new K(7);
  const get = k.get;
  out.push(String(get.call(k)), String(get.apply(new K(8), [])), String(K.tag.call(K, "a")), String(K.tag.apply(K, ["b"])));
  const bound = add.bind({ base: 1 });
  out.push(String(bound.call({ base: 1000 }, 2, 3)), String(bound.apply({ base: 1000 }, [4, 5])));
  out.push(String(Math.max.apply(null, [3, 9, 2])), String(Math.min.call(null, 4, 1, 6)), String(Math.max.apply(null, [])));
  const few = function (this: unknown, a?: number, b?: number): string { return String(a) + "," + String(b) + "," + arguments.length; };
  out.push(few.call(null), few.call(null, 1), few.call(null, 1, 2, 3), few.apply(null, [1]), few.apply(null));
  const likeArgs = { length: 2, 0: 11, 1: 22 } as unknown as number[];
  out.push(String(add.apply(ctx, likeArgs)));
  const thrown: string[] = [];
  const notFn = 42 as unknown as (x: number) => number;
  try { notFn.call(null, 1); } catch (e) { thrown.push((e as Error).constructor.name); }
  try { (undefined as unknown as (x: number) => number).apply(null, [1]); } catch (e) { thrown.push((e as Error).constructor.name); }
  out.push(thrown.join(","));
  console.log(out.join("\n"));
}
main();
