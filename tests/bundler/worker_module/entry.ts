// A worker in a module of its own (new URL("./worker.mjs", import.meta.url):
// the harness runs node on the transpiled .mjs files; garnet resolves it to
// worker.ts), with a helper module only the worker imports.
import { Worker } from "node:worker_threads";
import { label } from "./shared";
const w = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: [1, 2, 3] });
w.on("message", (m: { sum: number; label: string }) => console.log("reply", m.sum, m.label, label));
w.on("exit", (code: number) => console.log("exit", code));
