// A promise carries properties as any object does (Node's promisified `exec` returns a promise with a
// `.child`; hono's css helper keeps a class name's data on the promise it returns): string and
// symbol keys, Object.assign and a spread onto and from it, enumeration, `in` and hasOwnProperty,
// delete, the prototype (Promise.prototype, where then / catch / finally are values), instanceof,
// and a settled promise still settling after the writes (Session 358: a write was a silent no-op,
// then a TypeError).
const S = Symbol("s");
function promisedExec(cmd: string): Promise<string> & { child?: { pid: number } } {
  const p = new Promise<string>((resolve) => setTimeout(() => resolve("out:" + cmd), 0)) as Promise<string> & { child?: { pid: number } };
  p.child = { pid: 42 };
  return p;
}
async function main(): Promise<void> {
  const p = Promise.resolve("x") as unknown as Record<string | symbol, unknown> & Promise<string>;
  p.a = 2;
  p[S] = [1];
  const q = Object.assign(Promise.resolve("y"), { [S]: [3], b: 4 }) as unknown as Record<string | symbol, unknown> & Promise<string>;
  const spread = { ...q } as Record<string | symbol, unknown>;
  console.log(p.a, p[S], q[S], q.b, Object.keys(q), Object.getOwnPropertySymbols(q).length, JSON.stringify(p), spread.b, spread[S]);
  console.log("a" in p, Object.prototype.hasOwnProperty.call(p, "a"), "then" in p, Object.prototype.hasOwnProperty.call(p, "then"), typeof p.then, typeof p.catch, typeof p.finally);
  console.log(p instanceof Promise, Object.getPrototypeOf(p) === Object.getPrototypeOf(Promise.resolve(0)), Object.keys(Promise.resolve(0)), JSON.stringify(Promise.resolve(0)));
  delete p.a;
  console.log("a" in p, p.a);
  const e = promisedExec("ls");
  console.log(e.child?.pid, await e, e.child?.pid);
  console.log(await p, await q, q.b);
  const frozen = Object.freeze(Promise.resolve(1)) as unknown as Record<string, unknown>;
  try { frozen.z = 1; console.log("no throw"); } catch (err) { console.log("frozen write throws", err instanceof TypeError); }
}
main();
