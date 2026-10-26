// EXPECT-REJECT: a worker's module named by a value (a path string is relative
// to the working directory in Node; garnet resolves the module at compile time
// and accepts import.meta.url forms only)
import { Worker } from "node:worker_threads";
const file = process.argv[2] ?? "./worker.js";
const w = new Worker(file);
w.on("exit", (code: number) => console.log("exit", code));
