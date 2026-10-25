// The Node globals (docs/node_compat_design.md): the exporter evaluates this
// module first when a program names one of them or imports a node: module.
import process from "./process";
import { performance } from "./perf_hooks";
const g = globalThis as unknown as { process: unknown; global: unknown; performance: unknown; queueMicrotask: unknown };
g.process = process;
g.global = globalThis;
g.performance = performance;
g.queueMicrotask = (callback: () => void): void => { Promise.resolve().then(callback); };
