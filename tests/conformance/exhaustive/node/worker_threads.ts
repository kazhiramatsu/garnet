// node:worker_threads: a worker runs this file again with isMainThread false
// (Node: a fresh isolate; garnet: a fork of the initialized program whose
// top level is compiled as a function). Messages are structured copies; an
// uncaught exception in the worker is the parent's 'error', then 'exit' 1;
// terminate() ends a worker with exit code 1. Only the main thread prints.
import { Worker, isMainThread, parentPort, workerData, threadId } from "node:worker_threads";

interface Request { op: string; n: number }
interface Reply { result: number; tag: string; main: boolean; tid: boolean; type: string }

function runTerminate(): void {
  // terminated once it runs (it says so first): exit code 1, the 'exit' event before the promise
  const t = new Worker(new URL(import.meta.url), { workerData: { tag: "t", wait: true } });
  t.on("message", (m: string) => {
    console.log("second says", m);
    t.terminate().then((code: number) => console.log("terminate resolved", code));
  });
  t.on("exit", (code: number) => console.log("second exit", code));
}
function main(): void {
  console.log("main", isMainThread, threadId, workerData === null, parentPort === null);
  const w = new Worker(new URL(import.meta.url), { workerData: { tag: "x", wait: false } });
  let replies = 0;
  w.on("online", () => console.log("online"));
  w.on("message", (m: Reply) => {
    replies++;
    console.log("message", m.result, m.tag, m.main, m.tid, m.type);
    if (replies === 2) w.postMessage({ op: "boom", n: 0 });
  });
  w.on("error", (e: Error) => console.log("error", e.name, e.message, e instanceof Error));
  w.on("exit", (code: number) => { console.log("exit", code); runTerminate(); });
  w.postMessage({ op: "double", n: 21 });
  w.postMessage({ op: "square", n: 7 });
}
if (isMainThread) {
  main();
} else {
  const data = workerData as { tag: string; wait: boolean };
  if (data.wait) parentPort!.postMessage("ready");
  parentPort!.on("message", (m: Request) => {
    if (m.op === "double") parentPort!.postMessage({ result: m.n * 2, tag: data.tag, main: isMainThread, tid: threadId > 0, type: typeof data });
    else if (m.op === "square") parentPort!.postMessage({ result: m.n * m.n, tag: data.tag, main: isMainThread, tid: threadId > 0, type: typeof data });
    else throw new RangeError("the worker cannot " + m.op);
  });
}
