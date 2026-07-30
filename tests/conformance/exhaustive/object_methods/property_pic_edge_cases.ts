// Property-PIC edge cases. Every helper below is one emitted cache site, so the
// receiver/key sequences deliberately exercise shape sharing, replacement,
// megamorphic fallback, mutation invalidation, and exotic-object fallbacks.
function readX(value: any): any {
  return value.x;
}

function writeX(value: any, next: any): void {
  value.x = next;
}

function readY(value: any): any {
  return value.y;
}

function writeY(value: any, next: any): void {
  value.y = next;
}

function readAt(value: any, key: any): any {
  return value[key];
}

function writeAt(value: any, key: any, next: any): void {
  value[key] = next;
}

// Equal key sequences share a shape but must read each receiver's own slot.
const same1: any = { prefix: 0, x: "same-1" };
const same2: any = { prefix: 1, x: "same-2" };
console.log(readX(same1), readX(same2), readX(same1), readX(same2));

// Different insertion orders must not alias even when the final key set is the
// same. Six shapes also force replacement in the four-entry cache.
const ordered: any[] = [
  { x: "s0" },
  { a: 0, x: "s1" },
  { b: 0, c: 0, x: "s2" },
  { x: "s3", d: 0 },
  { e: 0, x: "s4", f: 0 },
  { g: 0, h: 0, i: 0, x: "s5" },
];
console.log(ordered.map(readX).join(","));
console.log(ordered.slice().reverse().map(readX).join(","));

// Twenty unique shapes cross the 16-miss megamorphic threshold. Correctness
// must remain stable after the cache permanently falls back.
const manyShapes: any[] = [];
for (let i = 0; i < 20; i++) {
  const value: any = {};
  value["unique" + i] = i;
  value.x = i * 10;
  manyShapes.push(value);
}
console.log(manyShapes.map(readX).join(","));
console.log(manyShapes.slice().reverse().map(readX).join(","));
for (let i = 0; i < manyShapes.length; i++) {
  writeX(manyShapes[i], i * 10 + 1);
}
console.log(manyShapes.map(readX).join(","));

// Deleting a property before a cached slot compacts the dense property vector.
// The object's dictionary shape must prevent the stale slot from being used.
const compacted: any = { before: "B", x: "old", after: "A" };
console.log(readX(compacted), readX(compacted));
delete compacted.before;
console.log(readX(compacted), compacted.after);
writeX(compacted, "after-compaction");
console.log(readX(compacted), compacted.after);
delete compacted.x;
console.log(readX(compacted));
compacted.x = "new";
console.log(readX(compacted), readX(compacted));

// A fixed shape can change between data/accessor forms. The cache must inspect
// current descriptor flags instead of treating a prior data hit as permanent.
let accessorBacking = 10;
const redefined: any = { x: 1 };
console.log(readX(redefined), readX(redefined));
Object.defineProperty(redefined, "x", {
  get() {
    return accessorBacking;
  },
  set(next: number) {
    accessorBacking = next;
  },
  configurable: true,
});
console.log(readX(redefined));
writeX(redefined, 11);
console.log(readX(redefined), accessorBacking);
Object.defineProperty(redefined, "x", {
  value: 12,
  writable: true,
  configurable: true,
});
console.log(readX(redefined), readX(redefined));

// A getter-only accessor is a strict-mode write error, including after the read
// side has warmed the same PIC site.
const getterOnly: any = {};
Object.defineProperty(getterOnly, "x", {
  get() {
    return 13;
  },
  configurable: true,
});
console.log(readX(getterOnly), readX(getterOnly));
try {
  writeX(getterOnly, 99);
  console.log("getter-only write did not throw");
} catch (error: any) {
  console.log(error instanceof TypeError);
}
console.log(readX(getterOnly));

const inheritedGetterOnlyProto: any = {};
Object.defineProperty(inheritedGetterOnlyProto, "x", {
  get() {
    return 14;
  },
  configurable: true,
});
const inheritedGetterOnly: any = Object.create(inheritedGetterOnlyProto);
console.log(readX(inheritedGetterOnly));
try {
  writeX(inheritedGetterOnly, 100);
  console.log("inherited getter-only write did not throw");
} catch (error: any) {
  console.log(error instanceof TypeError);
}
console.log(
  readX(inheritedGetterOnly),
  Object.getOwnPropertyDescriptor(inheritedGetterOnly, "x") !== undefined,
);

// Missing/inherited results are intentionally not cached. Adding/deleting an
// own property and replacing the prototype must therefore be immediately seen.
const proto1: any = { x: "proto-1" };
const proto2: any = { x: "proto-2" };
const child: any = Object.create(proto1);
console.log(readX(child), readX(child));
child.x = "own";
console.log(readX(child), readX(child));
delete child.x;
console.log(readX(child));
Object.setPrototypeOf(child, proto2);
console.log(readX(child), readX(child));

// An inherited accessor receives the original receiver for both get and set.
const accessorProto: any = {};
Object.defineProperty(accessorProto, "x", {
  get(this: any) {
    return this._value;
  },
  set(this: any, next: number) {
    this._value = next * 2;
  },
  configurable: true,
});
const accessorChild: any = Object.create(accessorProto);
accessorChild._value = 7;
console.log(readX(accessorChild));
writeX(accessorChild, 8);
console.log(readX(accessorChild), accessorChild._value);

// Descriptor and integrity changes preserve the key sequence but must block a
// previously warm write cache.
const readonly: any = { x: 20 };
writeX(readonly, 21);
Object.defineProperty(readonly, "x", {
  value: 22,
  writable: false,
  configurable: true,
});
try {
  writeX(readonly, 23);
} catch (error: any) {
  console.log(error instanceof TypeError);
}
console.log(readX(readonly));

const frozen: any = { x: 30 };
writeX(frozen, 31);
Object.freeze(frozen);
try {
  writeX(frozen, 32);
} catch (error: any) {
  console.log(error instanceof TypeError);
}
console.log(readX(frozen));

const nonExtensible: any = { x: 40 };
console.log(readY(nonExtensible));
Object.preventExtensions(nonExtensible);
try {
  writeY(nonExtensible, 41);
} catch (error: any) {
  console.log(error instanceof TypeError);
}
console.log(readY(nonExtensible));

// A computed-key site must distinguish strings, numbers, user symbols, and
// well-known symbols while still applying ToPropertyKey on every access.
const userSymbol = Symbol("pic");
const dynamic: any = { x: "string", 0: "zero" };
dynamic[userSymbol] = "symbol";
dynamic[Symbol.iterator] = "iterator";
const dynamicKeys: any[] = ["x", 0, "0", userSymbol, Symbol.iterator, "missing"];
console.log(dynamicKeys.map((key) => String(readAt(dynamic, key))).join(","));
writeAt(dynamic, userSymbol, "symbol-2");
writeAt(dynamic, 0, "zero-2");
console.log(readAt(dynamic, userSymbol), readAt(dynamic, "0"));

// A stable receiver with twenty distinct keys makes the key guard, rather than
// the shape guard, drive a computed-key site megamorphic.
const manyKeys: any = {};
const keyNames: string[] = [];
for (let i = 0; i < 20; i++) {
  const key = "key" + i;
  keyNames.push(key);
  manyKeys[key] = i;
}
console.log(keyNames.map((key) => readAt(manyKeys, key)).join(","));
console.log(keyNames.slice().reverse().map((key) => readAt(manyKeys, key)).join(","));
for (let i = 0; i < keyNames.length; i++) {
  writeAt(manyKeys, keyNames[i], i + 100);
}
console.log(keyNames.map((key) => readAt(manyKeys, key)).join(","));

let coercions = 0;
const coercingKey: any = {
  toString() {
    coercions++;
    return "x";
  },
};
console.log(readAt(dynamic, coercingKey), readAt(dynamic, coercingKey), coercions);
writeAt(dynamic, coercingKey, "coerced");
console.log(readAt(dynamic, "x"), coercions);

// Proxy and built-in exotics must always use their canonical paths, even after
// ordinary objects have populated the same fixed and dynamic cache sites.
let proxyReads = 0;
let proxyWrites = 0;
const proxy: any = new Proxy({ x: 50 }, {
  get(target: any, key: any) {
    proxyReads++;
    return target[key] + 1;
  },
  set(target: any, key: any, value: any) {
    proxyWrites++;
    target[key] = value;
    return true;
  },
});
console.log(readX(same1), readX(proxy), readX(proxy), proxyReads);
writeX(proxy, 60);
console.log(readX(proxy), proxyReads, proxyWrites);

const array: any = [70, 71];
const text: any = "ab";
function fn(): void {}
(fn as any).x = 72;
console.log(
  readAt(array, 0),
  readAt(array, "1"),
  readAt(text, 1),
  readX(fn),
);

// Nullish receiver errors also go through the slow path after a site is warm.
try {
  readX(null);
} catch (error: any) {
  console.log(error instanceof TypeError);
}
try {
  readAt(undefined, "x");
} catch (error: any) {
  console.log(error instanceof TypeError);
}
