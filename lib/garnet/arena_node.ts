// garnet:arena under Node (docs/arena_design.md): where an allocation goes is the engine's, so the
// polyfill the V8 oracle and Node runs use calls the work and nothing else.

export function arena<T>(work: () => T): T {
  return work();
}
