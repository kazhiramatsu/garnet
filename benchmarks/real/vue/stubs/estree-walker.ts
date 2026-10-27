// A stand-in for estree-walker (the signature of the clone's packages/global.d.ts): vue's compiler walks a
// babel AST only when identifiers are prefixed, which the browser configuration (garnet-stubs/globals.ts)
// does not do.
export function walk<T>(
  _root: T,
  _options: {
    enter?: (node: T, parent: T | null) => any
    leave?: (node: T, parent: T | null) => any
    exit?: (node: T) => any
  } & ThisType<{ skip: () => void }>,
): void {
  throw new Error("garnet vue benchmark: estree-walker is not available");
}
