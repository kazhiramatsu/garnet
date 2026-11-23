// garnet:arena — allocation arenas (docs/arena_design.md).
//
// `arena(work)` runs `work` and returns what it returns. What `work` allocates is kept without being
// traced: when it returns, every object it made is old where it is, as if a collection had found it
// all alive, and no collection ran meanwhile. It is for work whose allocations nearly all outlive it,
// such as a parser's tree: a collection would mark and promote the tree a reference at a time, for
// the little that is garbage.
//
// In a shared worker (`new Worker(file, { shared: true })`) the objects made inside the arena are also
// published when it ends (garnet:shared): frozen, and passed by reference to the worker's parent. A
// `publish` of a graph made in an arena does not walk it. What that asks of the program: an object made
// inside the arena is not written after it, and the arena's objects refer to nothing that was made
// outside it and is written later.
//
// Under Node the same module name resolves to arena_node.ts, which calls `work` and nothing else.
import "garnet:shared";

/** The runtime's object (garnet:shared declares it), by the arena's two calls. */
interface ArenaHost {
  arenaBegin(): void;
  arenaEnd(): void;
}

/** Runs `work` in an arena and returns its result. Arenas nest: the outermost one is the arena. */
export function arena<T>(work: () => T): T {
  const host = __garnet as unknown as ArenaHost;
  host.arenaBegin();
  try {
    return work();
  } finally {
    host.arenaEnd();
  }
}
