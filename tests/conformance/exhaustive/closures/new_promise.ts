// `new Promise((resolve, reject) => {...})`: the executor runs synchronously and
// receives resolve/reject as first-class callables bound to the new promise.
// Each result is awaited in program order so the log order is deterministic
// (cross-chain microtask interleaving is not exercised here).
async function main(): Promise<void> {
  // resolve
  console.log(await new Promise<number>((res) => res(7))); // 7

  // reject -> caught
  console.log(await new Promise<number>((_res, rej) => rej("boom")).catch((e) => "c:" + e)); // c:boom

  // a throwing executor rejects the promise
  console.log(await new Promise<number>(() => { throw new Error("oops"); }).catch((e: any) => e.message)); // oops

  // resolve wins over a later resolve/reject (settle-once)
  console.log(await new Promise<number>((r) => { r(1); r(2); })); // 1
  console.log(await new Promise<number>((res, rej) => { res(3); rej("late"); })); // 3

  // resolving with an already-settled promise adopts its value
  console.log(await new Promise<number>((res) => res(Promise.resolve(9) as any))); // 9

  // chaining
  console.log(await new Promise<number>((res) => res(10)).then((v) => v + 1)); // 11

  // combinator interop
  console.log(await Promise.all([
    new Promise<number>((r) => r(1)),
    new Promise<number>((r) => r(2)),
    new Promise<number>((r) => r(3)),
  ]).then((xs) => xs[0] + xs[1] + xs[2])); // 6

  // §92: resolving with a PENDING promise chains — the outer settles when the
  // inner does (previously the outer was left unadopted). Settle inner BEFORE the
  // await so the value is deterministic regardless of exact tick count.
  let innerRes: (n: number) => void;
  const inner = new Promise<number>((r) => { innerRes = r; });
  const outer = new Promise<number>((r) => r(inner as any));
  innerRes!(42);
  console.log(await outer); // 42

  // §92: resolving with a pending promise that settles LATER still chains.
  let laterRes: (n: number) => void;
  const pending = new Promise<number>((r) => { laterRes = r; });
  const chained = new Promise<number>((r) => r(pending as any)).then((v) => v + 1);
  laterRes!(100);
  console.log(await chained); // 101

  // §92: rejection adoption — resolving with a rejected promise rejects.
  console.log(await new Promise<number>((r) => r(Promise.reject("bad") as any)).catch((e) => "c:" + e)); // c:bad
}

main();
