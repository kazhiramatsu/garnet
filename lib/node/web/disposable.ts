// Explicit resource management (docs/using_declarations_design.md): SuppressedError, DisposableStack,
// AsyncDisposableStack, the dispose methods of the iterators, and the three functions the rewrite of `using` calls.

const isObject = (v: any): boolean => (typeof v === "object" && v !== null) || typeof v === "function";
const dispose: any = (Symbol as any).dispose, asyncDispose: any = (Symbol as any).asyncDispose;

// SuppressedError is a NativeError in everything but its arguments: callable without `new`.
function SuppressedErrorCtor(this: any, error: any, suppressed: any, message: any): any {
  const O: any = new Error();
  delete O.message;
  const proto = new.target !== undefined ? new.target.prototype : undefined;
  Object.setPrototypeOf(O, isObject(proto) ? proto : SuppressedErrorCtor.prototype);
  if (message !== undefined) Object.defineProperty(O, "message", { value: `${message}`, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(O, "error", { value: error, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(O, "suppressed", { value: suppressed, writable: true, enumerable: false, configurable: true });
  return O;
}
Object.defineProperty(SuppressedErrorCtor, "name", { value: "SuppressedError", configurable: true });
Object.defineProperty(SuppressedErrorCtor, "length", { value: 3, configurable: true });
Object.setPrototypeOf(SuppressedErrorCtor, Error);
SuppressedErrorCtor.prototype = Object.create(Error.prototype);
Object.defineProperty(SuppressedErrorCtor, "prototype", { writable: false, enumerable: false, configurable: false });
Object.defineProperty(SuppressedErrorCtor.prototype, "constructor", { value: SuppressedErrorCtor, writable: true, enumerable: false, configurable: true });
Object.defineProperty(SuppressedErrorCtor.prototype, "name", { value: "SuppressedError", writable: true, enumerable: false, configurable: true });
Object.defineProperty(SuppressedErrorCtor.prototype, "message", { value: "", writable: true, enumerable: false, configurable: true });
export const SuppressedError: any = SuppressedErrorCtor;

// A list of { value, method } the rewrite or a stack holds, disposed in reverse order.
function suppress(failure: { has: boolean; error: any }, error: any): void {
  failure.error = failure.has ? new SuppressedError(error, failure.error) : error;
  failure.has = true;
}
function disposeResources(stack: any[], failure: { has: boolean; error: any }): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    const r = stack[i];
    try {
      if (r.method !== undefined) r.method.call(r.value);
    } catch (e) {
      suppress(failure, e);
    }
  }
}
async function disposeResourcesAsync(stack: any[], failure: { has: boolean; error: any }): Promise<void> {
  // an `await using` of null still awaits once, however many there are in a row
  let pending = false;
  for (let i = stack.length - 1; i >= 0; i--) {
    const r = stack[i];
    try {
      if (r.method !== undefined) {
        const result = r.method.call(r.value);
        if (r.isAsync) await result;
        pending = false;
      } else if (r.isAsync) pending = true;
    } catch (e) {
      suppress(failure, e);
      pending = false;
    }
    if (pending && (i === 0 || stack[i - 1].method !== undefined)) {
      await undefined;
      pending = false;
    }
  }
}
function getDisposeMethod(value: any, isAsync: boolean): any {
  if (isAsync) {
    const method = value[asyncDispose];
    if (method !== undefined && method !== null) {
      if (typeof method !== "function") throw new TypeError("The value at Symbol.asyncDispose is not a function");
      return method;
    }
  }
  const method = value[dispose];
  if (method === undefined || method === null) throw new TypeError(`${isAsync ? "Symbol.asyncDispose" : "Symbol.dispose"} is not a function`);
  if (typeof method !== "function") throw new TypeError("The value at Symbol.dispose is not a function");
  // a sync disposer behind `await using`: its result is not awaited, a throw becomes the await's
  return isAsync ? function (this: any) { method.call(this); } : method;
}
function addResource(stack: any[], value: any, isAsync: boolean): void {
  if (value === undefined || value === null) {
    if (isAsync) stack.push({ value, method: undefined, isAsync });
    return;
  }
  if (!isObject(value)) throw new TypeError("The value of a using declaration is neither an object nor null or undefined");
  stack.push({ value, method: getDisposeMethod(value, isAsync), isAsync });
}

// The rewrite: `const s = __garnet_using_stack(); try { const x = __garnet_use(e, s, 0); ... }
// catch (c) { s.failure.has = true; s.failure.error = c; } finally { __garnet_dispose(s); }`
export function __garnet_using_stack(): any { return { list: [], failure: { has: false, error: undefined } }; }
export function __garnet_use(value: any, s: any, isAsync: number): any {
  addResource(s.list, value, isAsync !== 0);
  return value;
}
export function __garnet_dispose(s: any): void {
  disposeResources(s.list, s.failure);
  if (s.failure.has) throw s.failure.error;
}
export async function __garnet_dispose_async(s: any): Promise<void> {
  await disposeResourcesAsync(s.list, s.failure);
  if (s.failure.has) throw s.failure.error;
}

export class DisposableStack {
  #disposed = false;
  #stack: any[] = [];
  get disposed(): boolean { return this.#disposed; }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const failure = { has: false, error: undefined };
    const stack = this.#stack;
    this.#stack = [];
    disposeResources(stack, failure);
    if (failure.has) throw failure.error;
  }
  use(value: any): any {
    if (this.#disposed) throw new ReferenceError("Cannot call DisposableStack.prototype.use on an already-disposed DisposableStack");
    addResource(this.#stack, value, false);
    return value;
  }
  adopt(value: any, onDispose: any): any {
    if (this.#disposed) throw new ReferenceError("Cannot call DisposableStack.prototype.adopt on an already-disposed DisposableStack");
    if (typeof onDispose !== "function") throw new TypeError("The onDispose argument is not a function");
    this.#stack.push({ value: undefined, method: function () { onDispose(value); }, isAsync: false });
    return value;
  }
  defer(onDispose: any): void {
    if (this.#disposed) throw new ReferenceError("Cannot call DisposableStack.prototype.defer on an already-disposed DisposableStack");
    if (typeof onDispose !== "function") throw new TypeError("The onDispose argument is not a function");
    this.#stack.push({ value: undefined, method: function () { onDispose(); }, isAsync: false });
  }
  move(): DisposableStack {
    if (this.#disposed) throw new ReferenceError("Cannot call DisposableStack.prototype.move on an already-disposed DisposableStack");
    const moved = new DisposableStack();
    moved.#stack = this.#stack;
    this.#stack = [];
    this.#disposed = true;
    return moved;
  }
}
Object.defineProperty(DisposableStack.prototype, dispose, { value: DisposableStack.prototype.dispose, writable: true, enumerable: false, configurable: true });
Object.defineProperty(DisposableStack.prototype, Symbol.toStringTag, { value: "DisposableStack", writable: false, enumerable: false, configurable: true });

export class AsyncDisposableStack {
  #disposed = false;
  #stack: any[] = [];
  get disposed(): boolean { return this.#disposed; }
  async disposeAsync(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const failure = { has: false, error: undefined };
    const stack = this.#stack;
    this.#stack = [];
    await disposeResourcesAsync(stack, failure);
    if (failure.has) throw failure.error;
  }
  use(value: any): any {
    if (this.#disposed) throw new ReferenceError("Cannot call AsyncDisposableStack.prototype.use on an already-disposed AsyncDisposableStack");
    addResource(this.#stack, value, true);
    return value;
  }
  adopt(value: any, onDisposeAsync: any): any {
    if (this.#disposed) throw new ReferenceError("Cannot call AsyncDisposableStack.prototype.adopt on an already-disposed AsyncDisposableStack");
    if (typeof onDisposeAsync !== "function") throw new TypeError("The onDisposeAsync argument is not a function");
    this.#stack.push({ value: undefined, method: function () { return onDisposeAsync(value); }, isAsync: true });
    return value;
  }
  defer(onDisposeAsync: any): void {
    if (this.#disposed) throw new ReferenceError("Cannot call AsyncDisposableStack.prototype.defer on an already-disposed AsyncDisposableStack");
    if (typeof onDisposeAsync !== "function") throw new TypeError("The onDisposeAsync argument is not a function");
    this.#stack.push({ value: undefined, method: function () { return onDisposeAsync(); }, isAsync: true });
  }
  move(): AsyncDisposableStack {
    if (this.#disposed) throw new ReferenceError("Cannot call AsyncDisposableStack.prototype.move on an already-disposed AsyncDisposableStack");
    const moved = new AsyncDisposableStack();
    moved.#stack = this.#stack;
    this.#stack = [];
    this.#disposed = true;
    return moved;
  }
}
Object.defineProperty(AsyncDisposableStack.prototype, asyncDispose, { value: AsyncDisposableStack.prototype.disposeAsync, writable: true, enumerable: false, configurable: true });
Object.defineProperty(AsyncDisposableStack.prototype, Symbol.toStringTag, { value: "AsyncDisposableStack", writable: false, enumerable: false, configurable: true });

// %IteratorPrototype%[@@dispose]: `return` if there is one; the async form awaits it.
const iteratorDispose = {
  [dispose](this: any): void {
    const ret = this.return;
    if (ret !== undefined && ret !== null) ret.call(this);
  },
};
const iteratorProto = (globalThis as any).Iterator?.prototype;
if (iteratorProto !== undefined) {
  Object.defineProperty(iteratorProto, dispose, { value: iteratorDispose[dispose], writable: true, enumerable: false, configurable: true });
}
