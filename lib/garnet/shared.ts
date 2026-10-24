// garnet:shared — published graphs (docs/published_graphs_design.md).
//
// `publish(graph)` makes every object reachable from `graph` immutable and
// returns it: plain objects, arrays and class instances as `Object.freeze`
// does (writes throw in strict code), functions with the variables they
// capture, and Maps and Sets, whose `set`, `add`, `delete` and `clear` throw.
// A graph holding an ArrayBuffer, a typed array, a WeakMap, a WeakSet, a
// Promise or a Proxy is rejected with a TypeError before anything is frozen.
// Sharing is the implementation's: where the receiver of a `postMessage`
// shares memory with the sender (garnet's workers), a published graph is
// passed by reference; elsewhere it is copied.
//
// This file is the garnet binding (the runtime's `__garnet`); under Node the
// same module name resolves to shared_node.ts, a polyfill with the same
// semantics (scripts/garnet_scheme_loader.mjs).

declare global {
  var __garnet: {
    publish(graph: unknown): unknown;
    isPublished(value: unknown): boolean;
    sharesGraphs: boolean;
  };
}

/** Makes the graph reachable from `graph` immutable and returns `graph`. */
export function publish<T>(graph: T): T {
  return __garnet.publish(graph) as T;
}

/** Whether `value` is a primitive or an object a `publish` has reached. */
export function isPublished(value: unknown): boolean {
  return __garnet.isPublished(value);
}

/** Whether posting a published graph to a worker shares it (garnet) or copies it (Node). */
export const sharesGraphs: boolean = __garnet.sharesGraphs;
