// node:timers (docs/node_compat_design.md, N3): setTimeout, setInterval and
// setImmediate over the runtime's loop; a Timeout or Immediate object as Node
// returns, with ref/unref/hasRef/refresh and a number for the primitive.
import { host } from "./host";
import { invalidArgType } from "./errors";

/** Node's delay coercion: not a finite number in [1, 2^31-1] becomes 1. */
function coerceDelay(delay: unknown): number {
  const d = Number(delay);
  if (!(d >= 1 && d <= 2147483647)) return 1;
  return d;
}
function validateCallback(callback: unknown): asserts callback is (...args: unknown[]) => void {
  if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
}
export class Timeout {
  private _id: number;
  private readonly _delay: number;
  private readonly _repeat: boolean;
  constructor(id: number, delay: number, repeat: boolean) { this._id = id; this._delay = delay; this._repeat = repeat; }
  ref(): this { host.timerRef(this._id, true); return this; }
  unref(): this { host.timerRef(this._id, false); return this; }
  hasRef(): boolean { return host.timerHasRef(this._id); }
  refresh(): this { host.timerRefresh(this._id, this._delay); return this; }
  close(): this { host.timerClear(this._id); return this; }
  [Symbol.toPrimitive](): number { return this._id; }
  /** @internal */ get id(): number { return this._id; }
}
export class Immediate {
  private _id: number;
  constructor(id: number) { this._id = id; }
  ref(): this { host.immediateRef(this._id, true); return this; }
  unref(): this { host.immediateRef(this._id, false); return this; }
  hasRef(): boolean { return host.immediateHasRef(this._id); }
  /** @internal */ get id(): number { return this._id; }
}
export function setTimeout(callback: (...args: any[]) => void, delay?: number, ...args: any[]): Timeout {
  validateCallback(callback);
  const d = coerceDelay(delay);
  return new Timeout(host.timerAdd(callback, args.length === 0 ? undefined : args, d, 0), d, false);
}
export function setInterval(callback: (...args: any[]) => void, delay?: number, ...args: any[]): Timeout {
  validateCallback(callback);
  const d = coerceDelay(delay);
  return new Timeout(host.timerAdd(callback, args.length === 0 ? undefined : args, d, d), d, true);
}
export function setImmediate(callback: (...args: any[]) => void, ...args: any[]): Immediate {
  validateCallback(callback);
  return new Immediate(host.immediate(callback, args.length === 0 ? undefined : args));
}
function timerId(t: unknown): number | undefined {
  if (t instanceof Timeout) return t.id;
  if (typeof t === "number") return t;
  if (typeof t === "string") { const n = Number(t); return n === n ? n : undefined; }
  return undefined;
}
export function clearTimeout(timer: Timeout | number | string | undefined | null): void {
  const id = timerId(timer);
  if (id !== undefined) host.timerClear(id);
}
export const clearInterval: typeof clearTimeout = clearTimeout;
export function clearImmediate(immediate: Immediate | undefined | null): void {
  if (immediate instanceof Immediate) host.immediateClear(immediate.id);
}
const timers = { setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate, Timeout, Immediate };
export default timers;
