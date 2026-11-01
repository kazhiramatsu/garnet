// The species protocol as the specification writes it (docs/well_known_symbols_design.md). A program compiles this
// module only when it can tell: it names Symbol.species or isConcatSpreadable, extends Array, or gives an array a
// `constructor`. The runtime's array methods call in here for a receiver whose constructor is not Array (g_species,
// array_species_custom); every other array keeps the direct path. `this` is the receiver, as in the specification.

const isObject = (v: any): boolean => (typeof v === "object" && v !== null) || typeof v === "function";
export const MAX_SAFE = 9007199254740991;
export function toIntegerOrInfinity(v: any): number {
  const n = +v;
  return n !== n ? 0 : Math.trunc(n);
}
export function lengthOf(O: any): number {
  const n = toIntegerOrInfinity(O.length);
  return n <= 0 ? 0 : Math.min(n, MAX_SAFE);
}
export function relativeIndex(v: any, len: number): number {
  const n = toIntegerOrInfinity(v);
  return n < 0 ? Math.max(len + n, 0) : Math.min(n, len);
}
function createData(A: any, k: number, value: any): void {
  Object.defineProperty(A, k, { value, writable: true, enumerable: true, configurable: true });
}
function arraySpeciesCreate(O: any, length: number): any {
  if (!Array.isArray(O)) return arrayCreate(length);
  let C: any = O.constructor;
  if (isObject(C)) {
    C = C[Symbol.species];
    if (C === null) C = undefined;
  }
  if (C === undefined) return arrayCreate(length);
  if (typeof C !== "function") throw new TypeError("object.constructor[Symbol.species] is not a constructor");
  return new C(length);
}
export function arrayCreate(length: number): any {
  if (length > 4294967295) throw new RangeError("Invalid array length");
  return new Array(length);
}
export function requireCallable(fn: any): void {
  if (typeof fn !== "function") throw new TypeError(`${String(fn)} is not a function`);
}
function isConcatSpreadable(E: any): boolean {
  if (!isObject(E)) return false;
  const spreadable = E[Symbol.isConcatSpreadable];
  return spreadable !== undefined ? !!spreadable : Array.isArray(E);
}
function flattenIntoArray(target: any, source: any, sourceLen: number, start: number, depth: number, mapper?: any, thisArg?: any): number {
  let targetIndex = start;
  for (let k = 0; k < sourceLen; k++) {
    if (!(k in source)) continue;
    let element = source[k];
    if (mapper !== undefined) element = mapper.call(thisArg, element, k, source);
    if (depth > 0 && Array.isArray(element)) {
      targetIndex = flattenIntoArray(target, element, lengthOf(element), targetIndex, depth === Infinity ? depth : depth - 1);
    } else {
      if (targetIndex >= MAX_SAFE) throw new TypeError("Invalid array length");
      createData(target, targetIndex, element);
      targetIndex++;
    }
  }
  return targetIndex;
}
export function toObject(v: any): any {
  if (v === undefined || v === null) throw new TypeError("Array.prototype method called on null or undefined");
  if (typeof v === "object" && v instanceof String) v = v.toString();
  if (typeof v !== "string") return Object(v);
  // a String's elements read-only, as its exotic object has them
  const o = Object.create(String.prototype);
  Object.defineProperty(o, "length", { value: v.length });
  for (let i = 0; i < v.length; i++) Object.defineProperty(o, i, { value: v[i], enumerable: true });
  return o;
}

export const arrayMethods = {
  Array,
  map(this: any, fn: any, thisArg?: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    const A = arraySpeciesCreate(O, len);
    for (let k = 0; k < len; k++) if (k in O) createData(A, k, fn.call(thisArg, O[k], k, O));
    return A;
  },
  filter(this: any, fn: any, thisArg?: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    const A = arraySpeciesCreate(O, 0);
    let to = 0;
    for (let k = 0; k < len; k++) {
      if (!(k in O)) continue;
      const v = O[k];
      if (fn.call(thisArg, v, k, O)) createData(A, to++, v);
    }
    return A;
  },
  slice(this: any, start?: any, end?: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    let k = relativeIndex(start, len);
    const final = end === undefined ? len : relativeIndex(end, len);
    const A = arraySpeciesCreate(O, Math.max(final - k, 0));
    let n = 0;
    for (; k < final; k++, n++) if (k in O) createData(A, n, O[k]);
    A.length = n;
    return A;
  },
  splice(this: any, ...args: any[]): any {
    const O = toObject(this);
    const len = lengthOf(O);
    const actualStart = relativeIndex(args[0], len);
    const items = args.slice(2);
    const actualDeleteCount = args.length === 0 ? 0 : args.length === 1 ? len - actualStart
      : Math.min(Math.max(toIntegerOrInfinity(args[1]), 0), len - actualStart);
    if (len + items.length - actualDeleteCount > MAX_SAFE) throw new TypeError("Invalid array length");
    const A = arraySpeciesCreate(O, actualDeleteCount);
    for (let k = 0; k < actualDeleteCount; k++) if (actualStart + k in O) createData(A, k, O[actualStart + k]);
    A.length = actualDeleteCount;
    const count = items.length;
    if (count < actualDeleteCount) {
      for (let k = actualStart; k < len - actualDeleteCount; k++) {
        const from = k + actualDeleteCount, to = k + count;
        if (from in O) O[to] = O[from]; else delete O[to];
      }
      for (let k = len; k > len - actualDeleteCount + count; k--) delete O[k - 1];
    } else if (count > actualDeleteCount) {
      for (let k = len - actualDeleteCount; k > actualStart; k--) {
        const from = k + actualDeleteCount - 1, to = k + count - 1;
        if (from in O) O[to] = O[from]; else delete O[to];
      }
    }
    for (let k = 0; k < count; k++) O[actualStart + k] = items[k];
    O.length = len - actualDeleteCount + count;
    return A;
  },
  concat(this: any, ...items: any[]): any {
    const O = toObject(this);
    const A = arraySpeciesCreate(O, 0);
    let n = 0;
    for (const E of [O, ...items]) {
      if (isConcatSpreadable(E)) {
        const len = lengthOf(E);
        if (n + len > MAX_SAFE) throw new TypeError("Invalid array length");
        for (let k = 0; k < len; k++, n++) if (k in E) createData(A, n, E[k]);
      } else {
        if (n >= MAX_SAFE) throw new TypeError("Invalid array length");
        createData(A, n++, E);
      }
    }
    A.length = n;
    return A;
  },
  flat(this: any, depth?: any): any {
    const O = toObject(this);
    const sourceLen = lengthOf(O);
    let depthNum = 1;
    if (depth !== undefined) {
      depthNum = toIntegerOrInfinity(depth);
      if (depthNum < 0) depthNum = 0;
    }
    const A = arraySpeciesCreate(O, 0);
    flattenIntoArray(A, O, sourceLen, 0, depthNum);
    return A;
  },
  flatMap(this: any, fn: any, thisArg?: any): any {
    const O = toObject(this);
    const sourceLen = lengthOf(O);
    requireCallable(fn);
    const A = arraySpeciesCreate(O, 0);
    flattenIntoArray(A, O, sourceLen, 0, 1, fn, thisArg);
    return A;
  },
};
Object.defineProperty(globalThis, "__garnet_species", { value: arrayMethods, writable: false, enumerable: false, configurable: false });

// Array.from and Array.of construct `this`.
const builtinFrom = Array.from as any, builtinOf = Array.of as any;
const statics = {
  from(this: any, items: any, mapfn?: any, thisArg?: any): any {
    if (this === Array) return mapfn === undefined ? builtinFrom(items) : builtinFrom(items, mapfn, thisArg);
    if (mapfn !== undefined) requireCallable(mapfn);
    if (items === undefined || items === null) throw new TypeError(`${String(items)} is not iterable`);
    const isCtor = typeof this === "function";
    const usingIterator = items[Symbol.iterator];
    if (usingIterator !== undefined && usingIterator !== null) {
      requireCallable(usingIterator);
      const A = isCtor ? new this() : new Array();
      let k = 0;
      for (const next of { [Symbol.iterator]() { return usingIterator.call(items); } } as any) {
        createData(A, k, mapfn === undefined ? next : mapfn.call(thisArg, next, k));
        k++;
      }
      A.length = k;
      return A;
    }
    const arrayLike = Object(items);
    const len = lengthOf(arrayLike);
    const A = isCtor ? new this(len) : arrayCreate(len);
    for (let k = 0; k < len; k++) createData(A, k, mapfn === undefined ? arrayLike[k] : mapfn.call(thisArg, arrayLike[k], k));
    A.length = len;
    return A;
  },
  of(this: any, ...items: any[]): any {
    if (this === Array) return builtinOf(...items);
    const len = items.length;
    const A = typeof this === "function" ? new this(len) : arrayCreate(len);
    for (let k = 0; k < len; k++) createData(A, k, items[k]);
    A.length = len;
    return A;
  },
};
Object.defineProperty(Array, "from", { value: statics.from, writable: true, enumerable: false, configurable: true });
Object.defineProperty(Array, "of", { value: statics.of, writable: true, enumerable: false, configurable: true });
Object.defineProperty(statics.from, "length", { value: 1, configurable: true });
Object.defineProperty(statics.of, "length", { value: 0, configurable: true });

// The getters at @@species answer `this`.
for (const C of [Array, Map, Set, Promise, RegExp, ArrayBuffer, (globalThis as any).SharedArrayBuffer, Object.getPrototypeOf(Int8Array)]) {
  if (C === undefined) continue;
  const holder = { get [Symbol.species]() { return this; } };
  Object.defineProperty(C, Symbol.species, { ...Object.getOwnPropertyDescriptor(holder, Symbol.species), enumerable: false, configurable: true });
}

// Array.prototype[@@unscopables]: the methods added since `with` code was written
const unscopables = Object.create(null);
for (const name of ["at", "copyWithin", "entries", "fill", "find", "findIndex", "findLast", "findLastIndex", "flat", "flatMap", "includes", "keys", "toReversed", "toSorted", "toSpliced", "values"]) unscopables[name] = true;
Object.defineProperty(Array.prototype, Symbol.unscopables, { value: unscopables, writable: false, enumerable: false, configurable: true });
