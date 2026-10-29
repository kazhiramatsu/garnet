// then / catch / finally taken from a promise and called on other receivers, and the Promise
// constructor given a resolver that is not a function: V8's TypeErrors, word for word. catch is
// Invoke(this, "then", undefined, onRejected), so a thenable's own then runs; a call site typed
// Promise whose receiver is a thenable calls the thenable's method.
const p0 = Promise.resolve();
const thenFn = p0.then as unknown as { call(t: unknown, ...a: unknown[]): unknown };
const catchFn = p0.catch as unknown as { call(t: unknown, ...a: unknown[]): unknown };
const finallyFn = p0.finally as unknown as { call(t: unknown, ...a: unknown[]): unknown };
const show = (label: string, f: () => unknown): void => {
  try { console.log(label, "->", String(f())); } catch (e) { console.log(label, "->", (e as Error).name + ": " + (e as Error).message); }
};
for (const v of [{}, 1, undefined, "s", [1], null]) show("then on " + JSON.stringify(v), () => thenFn.call(v, () => {}));
show("catch on 5", () => catchFn.call(5, () => {}));
show("catch on undefined", () => catchFn.call(undefined, () => {}));
show("catch on {}", () => catchFn.call({}, () => {}));
show("catch on a thenable", () => catchFn.call({ then(a: unknown, b: unknown) { return "then got " + typeof a + " " + typeof b; } }, () => {}));
show("finally on 5", () => finallyFn.call(5, () => {}));
show("finally on {}", () => finallyFn.call({}, () => {}));
class Foo {}
for (const v of [123, undefined, null, "abc", {}, [1, 2], true, new Foo()]) show("executor " + (v instanceof Foo ? "Foo" : JSON.stringify(v)), () => new Promise(v as any));
const thenable = { then(f: (v: number) => void) { f(7); return "own then"; } } as unknown as Promise<number>;
show("typed then on a thenable", () => thenable.then((v) => console.log("thenable gave", v)));
