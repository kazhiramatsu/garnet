// node:worker_threads for tsc-ts: the main thread, no workers.
export const isMainThread = true;
export const workerData: unknown = null;
export const parentPort: {
  postMessage(value: unknown): void;
  on(event: string, listener: (value: unknown) => void): void;
  close(): void;
} | null = null;
export class Worker {
  constructor(_url: unknown, _options?: unknown) {
    throw new Error('worker threads are not available in the garnet build of tsc-ts (run with one checker)');
  }
  on(_event: string, _listener: (value: unknown) => void): this { return this; }
  postMessage(_value: unknown): void {}
  terminate(): Promise<number> { return Promise.resolve(0); }
}
