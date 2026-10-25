// Node's globals for a program without @types/node (docs/node_compat_design.md),
// with the types of lib/node; lib/node/prelude.ts creates them.
declare var process: import("./process").Process;
declare var global: typeof globalThis;
declare var Buffer: import("./buffer").BufferConstructor;
declare type Buffer = import("./buffer").Buffer;
