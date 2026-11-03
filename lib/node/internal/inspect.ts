// util.inspect's core: the runtime's formatter (runtime/inspect.c).
import { host } from "../host";

export function inspectValue(value: unknown, options?: unknown): string {
  return host.inspect(value, options);
}
