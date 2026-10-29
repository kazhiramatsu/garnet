// node:async_hooks (docs/async_context_design.md): AsyncLocalStorage over the runtime's current
// asynchronous context, a chain of frames `{ als, store, parent }` the host carries across every
// continuation (an await, a then, a timer, an immediate, a tick); AsyncResource captures it. The
// tracing API (createHook, executionAsyncId) is not provided.
import { host } from "./host";

interface Frame { als: AsyncLocalStorage<unknown>; store: unknown; parent: Frame | null }
const current = (): Frame | null => (host.asyncContext() as Frame | undefined) ?? null;
const enter = (frame: Frame | null): void => host.setAsyncContext(frame === null ? undefined : frame);

export class AsyncLocalStorage<T> {
  #disabled = false;
  /** a function that runs `fn` in the context of the call to `bind` */
  static bind<F extends (...args: unknown[]) => unknown>(fn: F): F {
    if (typeof fn !== "function") throw new TypeError("The \"fn\" argument must be of type function. Received " + typeof fn);
    const frame = current();
    return function (this: unknown, ...args: unknown[]): unknown {
      const prev = current();
      enter(frame);
      try { return fn.apply(this, args); } finally { enter(prev); }
    } as unknown as F;
  }
  /** a function that runs its argument in the context of the call to `snapshot` */
  static snapshot(): <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => R {
    const frame = current();
    return (fn, ...args) => {
      const prev = current();
      enter(frame);
      try { return fn(...args); } finally { enter(prev); }
    };
  }
  getStore(): T | undefined {
    if (this.#disabled) return undefined;
    for (let f = current(); f !== null; f = f.parent) if (f.als === (this as AsyncLocalStorage<unknown>)) return f.store as T;
    return undefined;
  }
  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    this.#disabled = false;   // a run after disable() enables the storage again, as Node's does
    const prev = current();
    enter({ als: this as AsyncLocalStorage<unknown>, store, parent: prev });
    try { return callback(...args); } finally { enter(prev); }
  }
  exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    if (this.#disabled) return callback(...args);
    const prev = current();
    enter({ als: this as AsyncLocalStorage<unknown>, store: undefined, parent: prev });
    try { return callback(...args); } finally { enter(prev); }
  }
  enterWith(store: T): void {
    this.#disabled = false;
    enter({ als: this as AsyncLocalStorage<unknown>, store, parent: current() });
  }
  disable(): void { this.#disabled = true; }
}

export class AsyncResource {
  #frame: Frame | null;
  readonly #type: string;
  constructor(type: string, _options?: unknown) {
    if (typeof type !== "string") throw new TypeError("The \"type\" argument must be of type string. Received " + typeof type);
    this.#type = type;
    this.#frame = current();
  }
  runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    const prev = current();
    enter(this.#frame);
    try { return fn.apply(thisArg, args); } finally { enter(prev); }
  }
  bind<F extends (...args: unknown[]) => unknown>(fn: F, thisArg?: unknown): F {
    const frame = this.#frame;
    const bound = function (this: unknown, ...args: unknown[]): unknown {
      const prev = current();
      enter(frame);
      try { return fn.apply(thisArg === undefined ? this : thisArg, args); } finally { enter(prev); }
    } as unknown as F;
    return bound;
  }
  static bind<F extends (...args: unknown[]) => unknown>(fn: F, type?: string, thisArg?: unknown): F {
    return new AsyncResource(type === undefined ? "bound-anonymous-fn" : type).bind(fn, thisArg);
  }
  emitDestroy(): this { return this; }
  asyncId(): number { return 0; }
  triggerAsyncId(): number { return 0; }
}
export default { AsyncLocalStorage, AsyncResource };
