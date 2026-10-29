// A Proxy whose target is a function is callable (ECMA-262 10.5.12): through a method read (the
// get trap answering another Proxy of a function, hono's client `client.api.items[":id"].$get()`),
// a direct call, Function.prototype.call, and `typeof` says "function" (a Proxy of a plain object
// stays an object and is not callable). The apply trap, or the target when there is none.
type Cb = (info: { path: string[]; args: unknown[] }) => unknown;
const createProxy = (callback: Cb, path: string[]): unknown => new Proxy(() => {}, {
  get(_obj, key) { if (typeof key !== "string" || key === "then") return undefined; return createProxy(callback, [...path, key]); },
  apply(_1, _2, args) { return callback({ path, args }); },
});
function main(): void {
  const client = createProxy((info) => info.path.join("/") + "(" + info.args.length + ")", []) as any;
  console.log(client.api.items[":id"].$get({ a: 1 }), client.x.y(), client(), typeof client, typeof client.z, typeof client === "function");
  const p = new Proxy(function f(this: unknown, a: number) { return "f" + a; }, {}) as any;
  const o = { m: p };
  const r = new Proxy(p, {}) as any;
  console.log(o.m(3), p(4), p.call(null, 5), r(6), typeof p, typeof r, typeof p === "object", typeof r !== "function");
  const plain = new Proxy({}, {}) as any;
  console.log(typeof plain, typeof plain === "object");
  try { plain(); } catch (e) { console.log("plain proxy:", (e as Error).name); }
  try { ({ m: plain } as any).m(); } catch (e) { console.log("plain proxy method:", (e as Error).name); }
}
main();
