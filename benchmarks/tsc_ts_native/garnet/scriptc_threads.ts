// @scriptc/threads for tsc-ts on one thread: publishing is the identity, and
// no graphs are shared with other threads.
export function publish<T>(value: T): T { return value; }
export const sharesPublishedGraphs = false;
