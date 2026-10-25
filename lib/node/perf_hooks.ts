// node:perf_hooks — the monotonic clock of `performance`.
import { host } from "./host";
export interface Performance {
  now(): number;
  readonly timeOrigin: number;
  toJSON(): { timeOrigin: number; now: number };
}
export const performance: Performance = {
  now(): number { return host.now(); },
  timeOrigin: host.timeOrigin(),
  toJSON(): { timeOrigin: number; now: number } { return { timeOrigin: this.timeOrigin, now: this.now() }; },
};
const perf_hooks = { performance };
export default perf_hooks;
