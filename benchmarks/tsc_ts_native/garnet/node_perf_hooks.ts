// node:perf_hooks for tsc-ts: the monotonic clock since the start.
import { host } from './host.js';
export const performance = { now: (): number => host.now() };
