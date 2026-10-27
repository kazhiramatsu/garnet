// Object.prototype.toString's builtin tags: the collections, Date, Error (and a subclass), Promise, the
// typed arrays, a generator, a Proxy (its target's array-ness), Math and JSON, the iterators. vue's
// toRawType sorts a value by this tag (a Map or Set into its collection handlers).
function main(): void {
  const t = Object.prototype.toString;
  const tag = (v: unknown): string => t.call(v).slice(8, -1);
  class C {}
  class E2 extends Error {}
  function* g(): Generator<number> { yield 1; }
  console.log(tag(new Map()), tag(new Set()), tag(new WeakMap()), tag(new WeakSet()), tag([]), tag({}), tag(new C()), tag(new Date(0)));
  console.log(tag(/x/), tag(() => 1), tag(null), tag(undefined), tag(1), tag("s"), tag(true), tag(Symbol("q")));
  console.log(tag(new Error("e")), tag(new E2("e")), tag(new TypeError("t")), tag(Promise.resolve(1)), tag(new Uint8Array(1)), tag(new ArrayBuffer(1)), tag(g()));
  console.log(tag(new Proxy({}, {})), tag(new Proxy([], {})), tag(new Proxy(new Map(), {})), tag(Math), tag(JSON), tag(new Map().entries()), tag([].values()));
  const tagged = { [Symbol.toStringTag]: "Custom" };
  console.log(tag(tagged), String(tagged), `${[1, 2]}`, String(new Map()));
  // vue's toRawType and the dispatch it drives
  const toRawType = (v: unknown): string => t.call(v).slice(8, -1);
  const kinds = [new Map<string, number>(), new Set<number>(), [], {}, new WeakMap(), new Date(0)].map((v) => toRawType(v) === "Map" || toRawType(v) === "Set" || toRawType(v) === "WeakMap" || toRawType(v) === "WeakSet" ? "collection" : toRawType(v) === "Object" || toRawType(v) === "Array" ? "common" : "invalid");
  console.log(kinds.join(","));
}
main();
