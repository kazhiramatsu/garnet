// Atomics.waitAsync (a program that names it compiles this): the waiters of one thread, woken by Atomics.notify through the
// runtime's hook or by their timeout.

const host = (globalThis as any).__garnet;
interface Waiter { buffer: any; byte: number; resolve: (v: string) => void; timer: any }
const waiters: Waiter[] = [];

host.atomicsNotifyHook((ta: any, index: number, count: number): number => {
  const byte = ta.byteOffset + index * ta.BYTES_PER_ELEMENT;
  let woken = 0;
  for (let i = 0; i < waiters.length && woken < count; ) {
    const w = waiters[i];
    if (w.buffer !== ta.buffer || w.byte !== byte) { i++; continue; }
    waiters.splice(i, 1);
    if (w.timer !== undefined) clearTimeout(w.timer);
    w.resolve("ok");
    woken++;
  }
  return woken;
});

function waitAsync(ta: any, index: any, value: any, timeout: any): any {
  const start = host.atomicsWaitStart(ta, index, value, timeout);
  if (start === "not-equal") return { async: false, value: "not-equal" };
  if (start === 0) return { async: false, value: "timed-out" };
  const i = Math.trunc(+index) || 0;
  const promise = new Promise((resolve: (v: string) => void) => {
    const w: Waiter = { buffer: ta.buffer, byte: ta.byteOffset + i * ta.BYTES_PER_ELEMENT, resolve, timer: undefined };
    waiters.push(w);
    if (start !== Infinity) {
      w.timer = setTimeout(() => {
        const at = waiters.indexOf(w);
        if (at >= 0) { waiters.splice(at, 1); resolve("timed-out"); }
      }, start);
      w.timer.unref?.();     // (a wait does not keep the process alive)
    }
  });
  return { async: true, value: promise };
}
Object.defineProperty(waitAsync, "length", { value: 4, configurable: true });
Object.defineProperty(Atomics, "waitAsync", { value: waitAsync, writable: true, enumerable: false, configurable: true });
