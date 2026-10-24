// node:worker_threads for tsc-ts: workers are forked processes
// (docs/fork_workers_design.md). The main process registers the entry a child
// runs (main.ts); `new Worker` forks, and the child sees the same objects.
// The bindings are live: a child enters worker mode before its entry runs.
import { host } from './host.js';

export let isMainThread = true;
export let workerData: unknown = null;
export let parentPort: {
  postMessage(value: unknown): void;
  on(event: string, listener: (value: unknown) => void): void;
  close(): void;
} | null = null;

/** The child's side: `workerData` and `parentPort`, then the entry (main.ts). */
export function enterWorker(data: unknown): void {
  isMainThread = false;
  workerData = data;
  parentPort = {
    postMessage(value: unknown): void { host.postMessage(value); },
    // Only parse threads listen on their port; this prototype starts none.
    on(_event: string, _listener: (value: unknown) => void): void {},
    close(): void {},
  };
}

export class Worker {
  private readonly id: number;
  constructor(_url: unknown, options?: { workerData?: unknown }) {
    // a parse thread returns bound source files to the main thread: a shared worker
    // (docs/published_graphs_design.md); a checker returns plain data
    const kind = (options?.workerData as { kind?: unknown } | undefined)?.kind;
    this.id = host.forkWorker(options?.workerData, kind === 'parse');
  }
  on(event: string, listener: (value: unknown) => void): this {
    if (event === 'message') host.onWorkerMessage(this.id, listener);
    else if (event === 'error') host.onWorkerError(this.id, listener);
    return this;
  }
  postMessage(_value: unknown): void {
    throw new Error('messages to a forked worker are not supported (parse threads are not started)');
  }
  terminate(): Promise<number> { return Promise.resolve(0); }
}
