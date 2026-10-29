// finally's continuation against a chain of then (V8's job order): onFinally's result becomes
// PromiseResolve(r).then(valueThunk), a promise the derived promise adopts, so the continuation runs
// two jobs after the cleanup. Every path: fulfilled and rejected, a cleanup returning a value, a
// promise, a rejected promise, a cleanup that throws. With the other common forms for reference:
// await of a value and of a promise, an async function returning a promise, resolve(promise).
const log: string[] = [];
async function a1(): Promise<void> { log.push("a1 start"); await null; log.push("a1 after await null"); await Promise.resolve(); log.push("a1 after await resolved"); }
async function a2(): Promise<number> { log.push("a2 start"); return Promise.resolve(1); }
let chain: Promise<unknown> = Promise.resolve();
for (let i = 1; i <= 9; i++) chain = chain.then(() => log.push("t" + i));
a1();
a2().then(() => log.push("a2 resolved"));
new Promise<number>((r) => r(Promise.resolve(2))).then(() => log.push("resolve(promise) settled"));
Promise.resolve(3).finally(() => log.push("finally cb")).then((v) => log.push("after finally " + v));
Promise.reject(new Error("r")).finally(() => log.push("finally on reject")).catch((e: Error) => log.push("caught after finally " + e.message));
Promise.resolve(1).finally(() => Promise.resolve("ignored")).then((v) => log.push("value kept " + v));
Promise.resolve(1).finally(() => { throw new Error("cleanup threw"); }).catch((e: Error) => log.push(e.message));
Promise.resolve(1).finally(() => Promise.reject(new Error("cleanup rejected"))).catch((e: Error) => log.push(e.message));
setTimeout(() => console.log(log.join("\n")), 0);
