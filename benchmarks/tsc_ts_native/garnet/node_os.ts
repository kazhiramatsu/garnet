// node:os for tsc-ts: one thread (the garnet build runs no workers), so the
// checkers default to one.
import { host } from './host.js';
export function availableParallelism(): number { return 1; }
export function totalmem(): number { return host.totalmem(); }
