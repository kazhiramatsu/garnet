// queueMicrotask: a job of its own, ordered with the promise jobs as Node orders them (after the
// jobs already queued, before those queued later), from the top level and from inside a job; a
// callback that is not a function is Node's ERR_INVALID_ARG_TYPE.
const log: string[] = [];
Promise.resolve().then(() => log.push("then 1")).then(() => log.push("then 2"));
queueMicrotask(() => { log.push("qm 1"); queueMicrotask(() => log.push("qm nested")); Promise.resolve().then(() => log.push("then from qm")); });
Promise.resolve().then(() => { log.push("then 3"); queueMicrotask(() => log.push("qm from then")); });
queueMicrotask(() => log.push("qm 2"));
try { queueMicrotask(123 as unknown as () => void); } catch (e) { log.push("bad callback: " + (e as Error).name + " " + (e as { code?: string }).code + " " + (e as Error).message); }
setTimeout(() => console.log(log.join("\n")), 0);
