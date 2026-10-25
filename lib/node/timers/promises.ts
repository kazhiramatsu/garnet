// node:timers/promises: the promise forms; setInterval is an async iterator.
import { setTimeout as setTimeoutCb, setImmediate as setImmediateCb, setInterval as setIntervalCb, clearInterval, Timeout } from "../timers";

export interface TimerOptions { ref?: boolean; signal?: { aborted: boolean; reason?: unknown } }
export function setTimeout<T = void>(delay?: number, value?: T, options?: TimerOptions): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeoutCb(() => resolve(value as T), delay);
    if (options !== undefined && options.ref === false) t.unref();
  });
}
export function setImmediate<T = void>(value?: T, options?: TimerOptions): Promise<T> {
  return new Promise<T>((resolve) => {
    const im = setImmediateCb(() => resolve(value as T));
    if (options !== undefined && options.ref === false) im.unref();
  });
}
export async function* setInterval<T = void>(delay?: number, value?: T, options?: TimerOptions): AsyncGenerator<T, void, unknown> {
  let pending = 0;
  let wake: (() => void) | undefined = undefined;
  const timer: Timeout = setIntervalCb(() => { pending++; if (wake !== undefined) { const w = wake; wake = undefined; w(); } }, delay);
  if (options !== undefined && options.ref === false) timer.unref();
  try {
    for (;;) {
      if (pending === 0) await new Promise<void>((resolve) => { wake = resolve; });
      pending--;
      yield value as T;
    }
  } finally {
    clearInterval(timer);
  }
}
export const scheduler = {
  wait(delay?: number, options?: TimerOptions): Promise<void> { return setTimeout(delay, undefined, options); },
  yield(): Promise<void> { return setImmediate(); },
};
const timersPromises = { setTimeout, setImmediate, setInterval, scheduler };
export default timersPromises;
