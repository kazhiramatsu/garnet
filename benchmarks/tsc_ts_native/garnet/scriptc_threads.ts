// @scriptc/threads for tsc-ts on forked workers (docs/fork_workers_design.md):
// a child sees the parent's objects, so graphs are shared by reference and
// publishing is the identity (the checkers never write the program; a write
// would land in the child's private copy of the page).
export function publish<T>(value: T): T { return value; }
export const sharesPublishedGraphs = true;
