// Node's globals for a program without @types/node (docs/node_compat_design.md),
// with the types of lib/node; lib/node/prelude.ts creates them.
declare var process: import("./process").Process;
declare var global: typeof globalThis;
declare var Buffer: import("./buffer").BufferConstructor;
declare type Buffer = import("./buffer").Buffer;
declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): import("./timers").Immediate;
declare function clearImmediate(immediate: import("./timers").Immediate | undefined | null): void;
// Node's timer types win over the browser library's `number` (a later declaration's overload is tried first).
declare function setTimeout(callback: (...args: any[]) => void, delay?: number, ...args: any[]): import("./timers").Timeout;
declare function setInterval(callback: (...args: any[]) => void, delay?: number, ...args: any[]): import("./timers").Timeout;
declare function clearTimeout(timer: import("./timers").Timeout | number | string | undefined | null): void;
declare function clearInterval(timer: import("./timers").Timeout | number | string | undefined | null): void;
