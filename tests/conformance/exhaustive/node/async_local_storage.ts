// node:async_hooks's AsyncLocalStorage (lib/node/async_hooks.ts, docs/async_context_design.md):
// a store seen after awaits, in a then, a timer, an immediate, a tick, a queued microtask and a
// for-await; nested and sequential runs; exit, enterWith, disable, bind, snapshot; two storages
// side by side; AsyncResource.runInAsyncScope. Node's own module is the oracle.
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
const als = new AsyncLocalStorage<string>();
const other = new AsyncLocalStorage<number>();
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));
const log: string[] = [];
const see = (label: string): void => { log.push(`${label}=${String(als.getStore())}`); };
async function worker(name: string): Promise<string> {
  see(name + ":start");
  await tick();
  see(name + ":after-timer");
  await Promise.resolve();
  see(name + ":after-microtask");
  return name + ":" + String(als.getStore());
}
async function main(): Promise<void> {
  see("outside");
  const results = await Promise.all([als.run("A", () => worker("a")), als.run("B", () => worker("b"))]);
  console.log(results, als.getStore());
  const nested = als.run("outer", () => {
    const inner = als.run("inner", () => als.getStore());
    return [inner, als.getStore(), other.getStore()];
  });
  console.log(nested, als.getStore());
  await als.run("both", async () => {
    await other.run(7, async () => {
      await tick();
      console.log("two storages:", als.getStore(), other.getStore());
      console.log("exit:", als.exit(() => [als.getStore(), other.getStore()]), als.getStore());
    });
    console.log("after inner run:", als.getStore(), other.getStore());
    await new Promise<void>((resolve) => {
      setTimeout(() => { see("timeout"); setImmediate(() => { see("immediate"); process.nextTick(() => { see("tick"); queueMicrotask(() => { see("microtask"); resolve(); }); }); }); }, 1);
    });
    const viaThen = await Promise.resolve(1).then((v) => `then:${v}:${String(als.getStore())}`);
    console.log(viaThen);
    const seen: string[] = [];
    for await (const v of (async function* () { yield 1; await tick(); yield 2; })()) seen.push(`${v}:${String(als.getStore())}`);
    console.log("for await:", seen);
  });
  console.log(log.join(" "));
  const bound = als.run("bound", () => AsyncLocalStorage.bind(() => als.getStore()));
  const snap = als.run("snap", () => AsyncLocalStorage.snapshot());
  console.log("bind:", bound(), "snapshot:", snap(() => als.getStore()), als.getStore());
  const resource = als.run("resource", () => new AsyncResource("probe"));
  console.log("resource:", resource.runInAsyncScope(() => als.getStore()), als.getStore());
  // a generator's body runs in the context of whoever calls next(), not the one it was made in
  function* gen(): Generator<string | undefined> { yield als.getStore(); yield als.getStore(); }
  const it = als.run("made", () => gen());
  console.log("generator:", als.run("first next", () => it.next().value), als.run("second next", () => it.next().value));
  // an async function started inside run keeps its context across its awaits, whoever resumes it
  const started = als.run("started", async () => { await tick(); await Promise.resolve(); return als.getStore(); });
  console.log("async across awaits:", await other.run(9, () => started));
  als.enterWith("entered");
  console.log("enterWith:", als.getStore(), await Promise.resolve().then(() => als.getStore()));
  als.disable();
  console.log("disabled:", als.getStore(), als.run("x", () => als.getStore()));
  als.enterWith("again");
  console.log("re-enabled:", als.getStore(), String(als), String(resource));
}
main();
