// Object.assign and an object spread copy a source's own enumerable symbol-keyed properties too, after
// its string keys (hono's css helper keeps a class name's selectors under symbols and spreads it into a
// String wrapper): the copy, the order Object.getOwnPropertySymbols reports, a non-enumerable symbol
// left out, a getter under a symbol read through the source, an array and a class instance as sources.
const S = Symbol("s");
const T = Symbol("t");
const H = Symbol("hidden");
class K { x = 1; [S] = "k"; }
function main(): void {
  const src: Record<string | symbol, unknown> = { a: 1, [S]: [1, 2], b: "two", [T]: "t" };
  Object.defineProperty(src, H, { value: "no", enumerable: false });
  const t1 = Object.assign({ [T]: "old" }, src) as Record<string | symbol, unknown>;
  console.log(Object.keys(t1), Object.getOwnPropertySymbols(t1).map(String), t1[S], t1[T], t1[H]);
  const t2 = { z: 0, ...src } as Record<string | symbol, unknown>;
  console.log(Object.keys(t2), Object.getOwnPropertySymbols(t2).map(String), t2[S], t2[T], H in t2);
  const w = Object.assign(new String("w"), src) as unknown as Record<string | symbol, unknown>;
  console.log(String(w), w.a, w[S], Object.getOwnPropertySymbols(w).length);
  const getter = { n: 21 } as Record<string | symbol, unknown>;
  Object.defineProperty(getter, S, { get() { return (this as { n: number }).n * 2; }, enumerable: true });
  console.log((Object.assign({}, getter) as Record<symbol, unknown>)[S], ({ ...getter } as Record<symbol, unknown>)[S]);
  const arr = [7, 8] as unknown as Record<string | symbol, unknown>;
  arr[S] = "on array";
  console.log(JSON.stringify(Object.assign({}, arr)), (Object.assign({}, arr) as Record<symbol, unknown>)[S], ({ ...arr } as Record<symbol, unknown>)[S]);
  const k = new K() as unknown as Record<string | symbol, unknown>;
  k[T] = "dyn";
  const fromK = { ...k } as Record<string | symbol, unknown>;
  console.log(fromK.x, fromK[S], fromK[T], Object.getOwnPropertySymbols(fromK).length);
  const multi = Object.assign({}, { [S]: 1 }, { [S]: 2, [T]: 3 }) as Record<symbol, unknown>;
  console.log(multi[S], multi[T]);
}
main();
