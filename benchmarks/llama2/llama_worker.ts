// llama_worker.ts: the worker of llama_core.ts's thread pool. Under garnet a fork of the loaded
// program (the model and the shared buffers are the parent's); under Node a fresh isolate that
// loads the model itself.
import { workerData } from "node:worker_threads";
import { workerLoop } from "./llama_core";
workerLoop(workerData as { ctrl: SharedArrayBuffer; xq: SharedArrayBuffer; xs: SharedArrayBuffer; xf: SharedArrayBuffer; out: SharedArrayBuffer; index: number; n: number; path: string });
