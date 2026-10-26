// llama_worker.ts: the worker of garnet:llama's thread pool (llama.ts). Under garnet a fork of the
// loaded program (the model and the shared buffers are the parent's); under Node a fresh isolate
// over the model's shared bytes, or a reader of the file when they are not shared.
import { workerData } from "node:worker_threads";
import { workerLoop, WorkerData } from "./llama";
workerLoop(workerData as WorkerData);
