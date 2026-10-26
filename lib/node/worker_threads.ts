// node:worker_threads (docs/node_compat_design.md, N5b): workers are forked
// processes of the initialized program (docs/fork_workers_design.md). The
// exporter resolves the module a `new Worker(...)` names (`import.meta.url`,
// `new URL("./w.js", import.meta.url)`, `fileURLToPath` of either) at compile
// time, compiles that module's top level as a function, and passes the
// function here; the child runs it with `isMainThread` false. Module-level
// state is the parent's at the fork, not fresh; messages are structured
// copies over a pipe (a published graph by reference from a `shared` worker).
import { EventEmitter } from "./events";
import { host } from "./host";
import { invalidArgType } from "./errors";
import type { URL } from "./url";

export interface WorkerOptions {
  workerData?: unknown;
  argv?: unknown[];
  env?: unknown;
  eval?: boolean;
  stdin?: boolean;
  stdout?: boolean;
  stderr?: boolean;
  execArgv?: string[];
  name?: string;
  resourceLimits?: ResourceLimits;
  transferList?: unknown[];
  trackUnmanagedFds?: boolean;
  /** garnet: the worker is forked into a region the parent maps shared, so a graph it
   *  publishes (`garnet:shared`) reaches the parent by reference. Node ignores the key. */
  shared?: boolean;
}
export interface ResourceLimits { maxYoungGenerationSizeMb?: number; maxOldGenerationSizeMb?: number; codeRangeSizeMb?: number; stackSizeMb?: number }

// Live bindings: the module's state at the fork is the parent's, so a forked child sets them
// through the start hook below before its entry runs.
export let isMainThread: boolean = true;
export let threadId: number = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let workerData: any = null;
export const resourceLimits: ResourceLimits = {};
export const SHARE_ENV: unique symbol = Symbol.for("nodejs.worker_threads.SHARE_ENV") as never;

function notAvailable(what: string): Error {
  return new TypeError(what + " is not available: a worker is a forked process and a port cannot be transferred (docs/node_compat_design.md)");
}

/** The parent's port as the worker sees it: messages from the parent, messages to it. */
export class MessagePort extends EventEmitter {
  private started = false;
  private closed = false;
  /** @internal the worker's end of the parent's channel; other ports cannot be made */
  constructor(internal?: symbol) {
    super();
    if (internal !== portKey) throw notAvailable("MessagePort");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "message") this.start();
    return this;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string | symbol, listener: (...args: any[]) => void): this {
    super.once(event, listener);
    if (event === "message") this.start();
    return this;
  }
  /** Delivery of the parent's messages begins; the open port keeps the worker alive. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    host.onParentMessage((value: unknown) => { this.emit("message", value); });
  }
  postMessage(value: unknown, _transferList?: unknown[]): void {
    if (this.closed) return;
    host.postMessage(value);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    host.closeParentPort();
    host.nextTick(() => { this.emit("close"); }, undefined);
  }
  ref(): this { return this; }
  unref(): this { return this; }
  hasRef(): boolean { return this.started && !this.closed; }
}
const portKey: unique symbol = Symbol("garnet.parentPort");
export let parentPort: MessagePort | null = null;
// the child: the worker's bindings, then the module's entry function (the exporter's)
host.setWorkerStart((entry: unknown, data: unknown, id: number): void => {
  isMainThread = false;
  threadId = id;
  workerData = data;
  parentPort = new MessagePort(portKey);
  (entry as () => void)();
});

export class MessageChannel {
  readonly port1!: MessagePort;
  readonly port2!: MessagePort;
  constructor() { throw notAvailable("MessageChannel"); }
}
export class BroadcastChannel extends EventEmitter {
  constructor(_name: string) { super(); throw notAvailable("BroadcastChannel"); }
}

/** A forked process running the named module's top level with `isMainThread` false. */
export class Worker extends EventEmitter {
  readonly threadId: number;
  private exited = false;
  private exitCode: number | null = null;
  constructor(filename: string | URL, options?: WorkerOptions) {
    super();
    if (typeof filename !== "function") {
      throw invalidArgType("filename", "a module of the program named statically (import.meta.url, or new URL(\"./w.js\", import.meta.url), possibly through fileURLToPath; garnet resolves the worker's module at compile time)", filename);
    }
    if (options !== undefined && options !== null && typeof options !== "object") throw invalidArgType("options", "of type object", options);
    if (options?.eval) throw new TypeError("new Worker: `eval: true` is not available: a worker runs a module of the program (docs/node_compat_design.md)");
    if (options?.stdout || options?.stderr || options?.stdin) throw new TypeError("new Worker: piped stdio (`stdout`, `stderr`, `stdin`) is not available: a worker writes to the process's streams (docs/node_compat_design.md)");
    if (options?.env !== undefined && options.env !== SHARE_ENV) throw new TypeError("new Worker: an `env` of its own is not available: a worker sees the process's environment (docs/node_compat_design.md)");
    if (options?.argv !== undefined && options.argv.length > 0) throw new TypeError("new Worker: `argv` is not available: a worker sees the process's arguments (docs/node_compat_design.md)");
    this.threadId = host.spawnWorker(filename, options?.workerData, options?.shared === true,
      (value: unknown) => { this.emit("message", value); },
      (error: unknown) => { this.emit("error", error); },
      (code: number) => { this.exited = true; this.exitCode = code; this.emit("exit", code); });
    host.nextTick(() => { if (!this.exited) this.emit("online"); }, undefined);
  }
  postMessage(value: unknown, _transferList?: unknown[]): void {
    if (this.exited) return;
    host.sendToWorker(this.threadId, value);
  }
  /** SIGTERM; the promise resolves with the exit code (1 for a terminated worker, as Node). */
  terminate(): Promise<number> {
    if (this.exited) return Promise.resolve(this.exitCode as number);
    return new Promise<number>((resolve) => {
      this.once("exit", (code: number) => resolve(code));
      host.killWorker(this.threadId);
    });
  }
  ref(): void { if (!this.exited) host.workerRef(this.threadId, true); }
  unref(): void { if (!this.exited) host.workerRef(this.threadId, false); }
  get performance(): { eventLoopUtilization(): { idle: number; active: number; utilization: number } } {
    return { eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }) };
  }
  getHeapSnapshot(): Promise<never> { return Promise.reject(notAvailable("getHeapSnapshot")); }
}

const environmentData = new Map<unknown, unknown>();
/** The main thread's entries at the fork are the worker's (Node clones them when the worker is made). */
export function getEnvironmentData(key: unknown): unknown { return environmentData.get(key); }
export function setEnvironmentData(key: unknown, value?: unknown): void {
  if (value === undefined) environmentData.delete(key); else environmentData.set(key, value);
}
export function receiveMessageOnPort(_port: MessagePort): { message: unknown } | undefined { throw notAvailable("receiveMessageOnPort"); }
export function moveMessagePortToContext(_port: MessagePort, _context: unknown): MessagePort { throw notAvailable("moveMessagePortToContext"); }
export function markAsUntransferable(_object: unknown): void {}
export function isMarkedAsUntransferable(_object: unknown): boolean { return false; }
export function markAsUncloneable(_object: unknown): void {}
export function postMessageToThread(_threadId: number, _value: unknown, _timeout?: number): Promise<void> { return Promise.reject(notAvailable("postMessageToThread")); }

// the default export reads the live bindings
const workerThreads = {
  get isMainThread(): boolean { return isMainThread; },
  get threadId(): number { return threadId; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get workerData(): any { return workerData; },
  get parentPort(): MessagePort | null { return parentPort; },
  resourceLimits, SHARE_ENV, Worker, MessagePort, MessageChannel, BroadcastChannel,
  getEnvironmentData, setEnvironmentData, receiveMessageOnPort, moveMessagePortToContext, markAsUntransferable, isMarkedAsUntransferable,
  markAsUncloneable, postMessageToThread,
};
export default workerThreads;
