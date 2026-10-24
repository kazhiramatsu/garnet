// garnet:shared under Node (docs/published_graphs_design.md): the polyfill
// the V8 oracle and Node runs use, with publish's semantics (a deep freeze;
// Maps and Sets rejecting mutation; the rejected kinds throwing before
// anything is frozen) and no sharing (a copy on post).

const published: WeakSet<object> = new WeakSet();

export function publish<T>(graph: T): T {
  polyfillPublish(graph);
  return graph;
}

export function isPublished(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return true;
  return published.has(value as object);
}

export const sharesGraphs: boolean = false;

function kindRejected(v: object): string | null {
  if (v instanceof ArrayBuffer) return "an ArrayBuffer";
  if (ArrayBuffer.isView(v)) return "a typed array";
  if (v instanceof WeakMap) return "a WeakMap";
  if (v instanceof WeakSet) return "a WeakSet";
  if (v instanceof Promise) return "a Promise";
  return null;
}

function children(v: object): unknown[] {
  const out: unknown[] = [];
  if (v instanceof Map) { for (const [k, val] of v) out.push(k, val); }
  else if (v instanceof Set) { for (const e of v) out.push(e); }
  for (const key of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d) continue;
    if ("value" in d) out.push(d.value); else out.push(d.get, d.set);
  }
  return out;
}

function polyfillPublish(root: unknown): void {
  const seen = new Set<object>();
  const order: object[] = [];
  const stack: unknown[] = [root];
  // first pass: the graph, the rejected kinds found before anything changes
  while (stack.length) {
    const v = stack.pop();
    if (v === null || (typeof v !== "object" && typeof v !== "function")) continue;
    const o = v as object;
    if (seen.has(o) || published.has(o)) continue;
    const rejected = kindRejected(o);
    if (rejected !== null) throw new TypeError("Cannot publish " + rejected);
    seen.add(o);
    order.push(o);
    for (const c of children(o)) stack.push(c);
  }
  // second pass: freeze
  for (const o of order) {
    if (o instanceof Map) guardCollection(o, "Map", ["set", "delete", "clear"]);
    else if (o instanceof Set) guardCollection(o, "Set", ["add", "delete", "clear"]);
    Object.freeze(o);
    published.add(o);
  }
}

function guardCollection(o: object, what: string, names: string[]): void {
  for (const name of names) {
    Object.defineProperty(o, name, {
      value: function (): never { throw new TypeError("Cannot modify a published " + what); },
      writable: false, enumerable: false, configurable: false,
    });
  }
}
