// node:events — EventEmitter as Node has it: listeners in insertion order,
// once-listeners removed before they run, an unhandled 'error' thrown,
// 'newListener' and 'removeListener' notifications, the listener-count warning.
import { codedError, invalidArgType } from "./errors";
import { inspectValue } from "./internal/inspect";
import { host } from "./host";

export type Listener = (...args: any[]) => void;
interface Entry { listener: Listener; once: boolean }

export const errorMonitor: unique symbol = Symbol("events.errorMonitor");

export class EventEmitter {
  static defaultMaxListeners = 10;
  static errorMonitor = errorMonitor;
  private _events: Map<string | symbol, Entry[]> = new Map();
  private _maxListeners = -1;
  private _warned: Set<string | symbol> | undefined = undefined;

  private _add(event: string | symbol, listener: Listener, once: boolean, prepend: boolean): this {
    if (typeof listener !== "function") throw invalidArgType("listener", "of type function", listener);
    if (this._events.has("newListener") && event !== "newListener") this.emit("newListener", event, listener);
    let list = this._events.get(event);
    if (list === undefined) { list = []; this._events.set(event, list); }
    const entry: Entry = { listener, once };
    if (prepend) list.unshift(entry); else list.push(entry);
    const max = this.getMaxListeners();
    if (max > 0 && list.length > max && !(this._warned !== undefined && this._warned.has(event))) {
      if (this._warned === undefined) this._warned = new Set();
      this._warned.add(event);
      const name = typeof event === "symbol" ? event.toString() : event;
      // as process.emitWarning prints it (the module does not depend on the global)
      host.write(2, "(node:" + host.pid() + ") MaxListenersExceededWarning: Possible EventEmitter memory leak detected. " +
        list.length + " " + name + " listeners added to " +
        (this.constructor.name === "" ? "[EventEmitter]" : "[" + this.constructor.name + "]") +
        ". MaxListeners is " + max + ". Use emitter.setMaxListeners() to increase limit\n");
    }
    return this;
  }
  on(event: string | symbol, listener: Listener): this { return this._add(event, listener, false, false); }
  addListener(event: string | symbol, listener: Listener): this { return this._add(event, listener, false, false); }
  prependListener(event: string | symbol, listener: Listener): this { return this._add(event, listener, false, true); }
  once(event: string | symbol, listener: Listener): this { return this._add(event, listener, true, false); }
  prependOnceListener(event: string | symbol, listener: Listener): this { return this._add(event, listener, true, true); }
  off(event: string | symbol, listener: Listener): this { return this.removeListener(event, listener); }
  removeListener(event: string | symbol, listener: Listener): this {
    if (typeof listener !== "function") throw invalidArgType("listener", "of type function", listener);
    const list = this._events.get(event);
    if (list === undefined) return this;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].listener === listener) {
        list.splice(i, 1);
        if (list.length === 0) this._events.delete(event);
        if (this._events.has("removeListener")) this.emit("removeListener", event, listener);
        break;
      }
    }
    return this;
  }
  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) {
      const names = this.eventNames();
      for (const name of names) if (name !== "removeListener") this.removeAllListeners(name);
      this.removeAllListeners("removeListener");
      this._events = new Map();
      return this;
    }
    const list = this._events.get(event);
    if (list === undefined) return this;
    this._events.delete(event);
    if (this._events.has("removeListener")) {
      for (let i = list.length - 1; i >= 0; i--) this.emit("removeListener", event, list[i].listener);
    }
    return this;
  }
  emit(event: string | symbol, ...args: any[]): boolean {
    if (event === "error") {
      const monitors = this._events.get(errorMonitor);
      if (monitors !== undefined) for (const m of monitors.slice()) m.listener.apply(this, args);
      const list = this._events.get("error");
      if (list === undefined || list.length === 0) {
        const err = args[0];
        if (err instanceof Error) throw err;
        const e = codedError("ERR_UNHANDLED_ERROR", "Unhandled error. (" + inspectValue(err) + ")");
        (e as unknown as { context: unknown }).context = err;
        throw e;
      }
    }
    const list = this._events.get(event);
    if (list === undefined || list.length === 0) return false;
    const snapshot = list.slice();
    for (const entry of snapshot) {
      if (entry.once) {
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0 && this._events.get(event) === list) this._events.delete(event);
        if (this._events.has("removeListener")) this.emit("removeListener", event, entry.listener);
      }
      entry.listener.apply(this, args);
    }
    return true;
  }
  listenerCount(event: string | symbol, listener?: Listener): number {
    const list = this._events.get(event);
    if (list === undefined) return 0;
    if (listener === undefined) return list.length;
    let n = 0;
    for (const e of list) if (e.listener === listener) n++;
    return n;
  }
  listeners(event: string | symbol): Listener[] {
    const list = this._events.get(event);
    return list === undefined ? [] : list.map((e) => e.listener);
  }
  rawListeners(event: string | symbol): Listener[] { return this.listeners(event); }
  eventNames(): (string | symbol)[] { return Array.from(this._events.keys()); }
  setMaxListeners(n: number): this {
    if (typeof n !== "number" || n < 0 || n !== n) throw invalidArgType("n", "a non-negative number", n);
    this._maxListeners = n;
    return this;
  }
  getMaxListeners(): number { return this._maxListeners < 0 ? EventEmitter.defaultMaxListeners : this._maxListeners; }
}

/** A promise of the next emission's arguments; the next 'error' rejects it. */
export function once(emitter: EventEmitter, name: string | symbol): Promise<any[]> {
  return new Promise<any[]>((resolve, reject) => {
    const onError = (err: unknown): void => { emitter.removeListener(name, onEvent); reject(err); };
    const onEvent = (...args: any[]): void => { if (name !== "error") emitter.removeListener("error", onError); resolve(args); };
    emitter.once(name, onEvent);
    if (name !== "error") emitter.once("error", onError);
  });
}
export function getEventListeners(emitter: EventEmitter, name: string | symbol): Listener[] { return emitter.listeners(name); }
export function listenerCount(emitter: EventEmitter, name: string | symbol): number { return emitter.listenerCount(name); }
export function setMaxListeners(n: number, ...emitters: EventEmitter[]): void {
  if (emitters.length === 0) EventEmitter.defaultMaxListeners = n;
  for (const e of emitters) e.setMaxListeners(n);
}
export default EventEmitter;
