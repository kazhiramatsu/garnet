// The first Errors of a run made in a shared worker: the main thread starts the worker before it has made
// one. A shared worker (garnet: a fork into a region its parent maps; Node ignores the option) cannot add a
// property name to the names it was forked with, so what an Error needs of the runtime must be there from
// the start: thrown and caught errors of the program's own, of the runtime (a property of null, an array
// length, JSON), of a class of the program, their names, messages, classes and stacks. The main thread makes
// the same errors after the worker has exited. Only the main thread prints.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

class Mine extends Error {
  code = 7;
  constructor(message: string) {
    super(message);
    this.name = "Mine";
  }
}

function work(): string[] {
  const out: string[] = [];
  try {
    throw new Error("made here");
  } catch (e) {
    out.push((e as Error).message, String(e instanceof Error), String(e));
  }
  try {
    const nothing: any = null;
    out.push(String(nothing.x));
  } catch (e) {
    out.push((e as Error).constructor.name, String(e instanceof TypeError));
  }
  try {
    JSON.parse("{");
    out.push("parsed");
  } catch (e) {
    out.push((e as Error).name);
  }
  try {
    const n: any = -1;
    out.push(String(new Array(n).length));
  } catch (e) {
    out.push((e as Error).name + ":" + String(e instanceof RangeError));
  }
  try {
    throw new Mine("own class");
  } catch (e) {
    const m = e as Mine;
    out.push(m.name, m.message, String(m.code), String(m instanceof Mine && m instanceof Error), typeof m.stack);
  }
  const kept = new TypeError("kept, not thrown");
  out.push(kept.name, kept.message, Object.prototype.toString.call(kept), String(Object.keys(kept).length));
  return out;
}

if (isMainThread) {
  const options = { shared: true };
  const w = new Worker(new URL(import.meta.url), options);
  w.on("message", (m: string[]) => console.log("worker:", m.join(" | ")));
  w.on("error", (e: Error) => console.log("worker error:", e.message));
  w.on("exit", (code: number) => {
    console.log("exit", code);
    console.log("main:", work().join(" | "));
  });
} else {
  parentPort!.postMessage(work());
}
