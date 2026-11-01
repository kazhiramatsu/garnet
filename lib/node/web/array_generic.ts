// Array.prototype's methods as the specification writes them, over any receiver (docs/array_protocol_design.md): an
// array-like, a Proxy, a dictionary array, one [[Get]] at each step, so a getter or a callback that changes the object is
// seen where the specification sees it. A program compiles this module when it can pass such a receiver: it names
// Array.prototype or borrows a method from an array literal. A plain array still takes the runtime's direct method.

import { arrayMethods, toObject, lengthOf, relativeIndex, toIntegerOrInfinity, requireCallable, arrayCreate, MAX_SAFE } from "./species";

const proto: any = Array.prototype;
const objectToString = Object.prototype.toString;
const toStr = (v: any): string => `${v}`;
const host = (globalThis as any).__garnet;

const generic: any = {
  map: arrayMethods.map, filter: arrayMethods.filter, slice: arrayMethods.slice, splice: arrayMethods.splice,
  concat: arrayMethods.concat, flat: arrayMethods.flat, flatMap: arrayMethods.flatMap,
  at(this: any, index: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    const rel = toIntegerOrInfinity(index);
    const k = rel >= 0 ? rel : len + rel;
    return k < 0 || k >= len ? undefined : O[k];
  },
  copyWithin(this: any, target: any, start: any, end: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    let to = relativeIndex(target, len);
    let from = relativeIndex(start, len);
    const final = end === undefined ? len : relativeIndex(end, len);
    let count = Math.min(final - from, len - to);
    let direction = 1;
    if (from < to && to < from + count) {
      direction = -1;
      from += count - 1;
      to += count - 1;
    }
    while (count > 0) {
      if (from in O) O[to] = O[from];
      else delete O[to];
      from += direction;
      to += direction;
      count--;
    }
    return O;
  },
  every(this: any, fn: any, thisArg: any): boolean {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    for (let k = 0; k < len; k++) if (k in O && !fn.call(thisArg, O[k], k, O)) return false;
    return true;
  },
  some(this: any, fn: any, thisArg: any): boolean {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    for (let k = 0; k < len; k++) if (k in O && fn.call(thisArg, O[k], k, O)) return true;
    return false;
  },
  forEach(this: any, fn: any, thisArg: any): void {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    for (let k = 0; k < len; k++) if (k in O) fn.call(thisArg, O[k], k, O);
  },
  fill(this: any, value: any, start: any, end: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    let k = relativeIndex(start, len);
    const final = end === undefined ? len : relativeIndex(end, len);
    for (; k < final; k++) O[k] = value;
    return O;
  },
  find(this: any, fn: any, thisArg: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    for (let k = 0; k < len; k++) {
      const v = O[k];
      if (fn.call(thisArg, v, k, O)) return v;
    }
    return undefined;
  },
  findIndex(this: any, fn: any, thisArg: any): number {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    for (let k = 0; k < len; k++) if (fn.call(thisArg, O[k], k, O)) return k;
    return -1;
  },
  findLast(this: any, fn: any, thisArg: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    for (let k = len - 1; k >= 0; k--) {
      const v = O[k];
      if (fn.call(thisArg, v, k, O)) return v;
    }
    return undefined;
  },
  findLastIndex(this: any, fn: any, thisArg: any): number {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    for (let k = len - 1; k >= 0; k--) if (fn.call(thisArg, O[k], k, O)) return k;
    return -1;
  },
  includes(this: any, search: any, fromIndex: any): boolean {
    const O = toObject(this);
    const len = lengthOf(O);
    if (len === 0) return false;
    const n = toIntegerOrInfinity(fromIndex);
    if (n === Infinity) return false;
    let k = n === -Infinity ? 0 : n >= 0 ? n : Math.max(len + n, 0);
    for (; k < len; k++) {
      const element = O[k];
      if (element === search || (element !== element && search !== search)) return true;
    }
    return false;
  },
  indexOf(this: any, search: any, fromIndex: any): number {
    const O = toObject(this);
    const len = lengthOf(O);
    if (len === 0) return -1;
    const n = toIntegerOrInfinity(fromIndex);
    if (n === Infinity) return -1;
    let k = n === -Infinity ? 0 : n >= 0 ? n : Math.max(len + n, 0);
    for (; k < len; k++) if (k in O && O[k] === search) return k;
    return -1;
  },
  lastIndexOf(this: any, search: any, fromIndex: any): number {
    const O = toObject(this);
    const len = lengthOf(O);
    if (len === 0) return -1;
    const n = arguments.length > 1 ? toIntegerOrInfinity(fromIndex) : len - 1;
    if (n === -Infinity) return -1;
    let k = n >= 0 ? Math.min(n, len - 1) : len + n;
    for (; k >= 0; k--) if (k in O && O[k] === search) return k;
    return -1;
  },
  join(this: any, separator: any): string {
    const O = toObject(this);
    const len = lengthOf(O);
    const sep = separator === undefined ? "," : toStr(separator);
    let R = "";
    for (let k = 0; k < len; k++) {
      if (k > 0) R += sep;
      const element = O[k];
      if (element !== undefined && element !== null) R += toStr(element);
    }
    return R;
  },
  toString(this: any): string {
    const O = toObject(this);
    const func = O.join;
    return typeof func === "function" ? func.call(O) : objectToString.call(O);
  },
  toLocaleString(this: any): string {
    const O = toObject(this);
    const len = lengthOf(O);
    let R = "";
    for (let k = 0; k < len; k++) {
      if (k > 0) R += ",";
      const element = O[k];
      if (element !== undefined && element !== null) R += toStr(element.toLocaleString());
    }
    return R;
  },
  pop(this: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    if (len === 0) {
      O.length = 0;
      return undefined;
    }
    const newLen = len - 1;
    const element = O[newLen];
    delete O[newLen];
    O.length = newLen;
    return element;
  },
  push(this: any, ...items: any[]): number {
    const O = toObject(this);
    let len = lengthOf(O);
    if (len + items.length > MAX_SAFE) throw new TypeError(`Pushing ${items.length} elements on an array-like of length ${len} is disallowed by ECMA-262`);
    for (let i = 0; i < items.length; i++) O[len++] = items[i];
    O.length = len;
    return len;
  },
  reduce(this: any, fn: any, initial: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    let k = 0;
    let accumulator: any;
    if (arguments.length > 1) accumulator = initial;
    else {
      let present = false;
      for (; !present && k < len; k++) {
        present = k in O;
        if (present) accumulator = O[k];
      }
      if (!present) throw new TypeError("Reduce of empty array with no initial value");
    }
    for (; k < len; k++) if (k in O) accumulator = fn(accumulator, O[k], k, O);
    return accumulator;
  },
  reduceRight(this: any, fn: any, initial: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    requireCallable(fn);
    let k = len - 1;
    let accumulator: any;
    if (arguments.length > 1) accumulator = initial;
    else {
      let present = false;
      for (; !present && k >= 0; k--) {
        present = k in O;
        if (present) accumulator = O[k];
      }
      if (!present) throw new TypeError("Reduce of empty array with no initial value");
    }
    for (; k >= 0; k--) if (k in O) accumulator = fn(accumulator, O[k], k, O);
    return accumulator;
  },
  reverse(this: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    const middle = Math.floor(len / 2);
    for (let lower = 0; lower !== middle; lower++) {
      const upper = len - lower - 1;
      const lowerExists = lower in O;
      const upperExists = upper in O;
      const lowerValue = lowerExists ? O[lower] : undefined;
      const upperValue = upperExists ? O[upper] : undefined;
      if (lowerExists && upperExists) {
        O[lower] = upperValue;
        O[upper] = lowerValue;
      } else if (upperExists) {
        O[lower] = upperValue;
        delete O[upper];
      } else if (lowerExists) {
        delete O[lower];
        O[upper] = lowerValue;
      }
    }
    return O;
  },
  shift(this: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    if (len === 0) {
      O.length = 0;
      return undefined;
    }
    const first = O[0];
    for (let k = 1; k < len; k++) {
      if (k in O) O[k - 1] = O[k];
      else delete O[k - 1];
    }
    delete O[len - 1];
    O.length = len - 1;
    return first;
  },
  unshift(this: any, ...items: any[]): number {
    const O = toObject(this);
    const len = lengthOf(O);
    const argCount = items.length;
    if (argCount > 0) {
      if (len + argCount > MAX_SAFE) throw new TypeError("Invalid array length");
      for (let k = len; k > 0; k--) {
        const from = k - 1, to = k + argCount - 1;
        if (from in O) O[to] = O[from];
        else delete O[to];
      }
      for (let j = 0; j < argCount; j++) O[j] = items[j];
    }
    O.length = len + argCount;
    return len + argCount;
  },
  sort(this: any, comparefn: any): any {
    if (comparefn !== undefined && typeof comparefn !== "function") throw new TypeError("The comparison function must be either a function or undefined");
    const O = toObject(this);
    const len = lengthOf(O);
    const items: any[] = [];
    for (let k = 0; k < len; k++) if (k in O) items.push(O[k]);
    builtinSort.call(items, comparefn);
    let j = 0;
    for (; j < items.length; j++) O[j] = items[j];
    for (; j < len; j++) if (j in O) delete O[j];
    return O;
  },
  toReversed(this: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    const A = arrayCreate(len);
    for (let k = 0; k < len; k++) A[k] = O[len - k - 1];
    return A;
  },
  toSorted(this: any, comparefn: any): any {
    if (comparefn !== undefined && typeof comparefn !== "function") throw new TypeError("The comparison function must be either a function or undefined");
    const O = toObject(this);
    const len = lengthOf(O);
    const A = arrayCreate(len);
    for (let k = 0; k < len; k++) A[k] = O[k];
    builtinSort.call(A, comparefn);
    return A;
  },
  toSpliced(this: any, ...args: any[]): any {
    const O = toObject(this);
    const len = lengthOf(O);
    const actualStart = relativeIndex(args[0], len);
    const items = args.slice(2);
    const skipCount = args.length === 0 ? 0 : args.length === 1 ? len - actualStart
      : Math.min(Math.max(toIntegerOrInfinity(args[1]), 0), len - actualStart);
    const newLen = len + items.length - skipCount;
    if (newLen > MAX_SAFE) throw new TypeError("Invalid array length");
    const A = arrayCreate(newLen);
    let i = 0;
    for (; i < actualStart; i++) A[i] = O[i];
    for (let j = 0; j < items.length; j++) A[i++] = items[j];
    for (let r = actualStart + skipCount; i < newLen; i++, r++) A[i] = O[r];
    return A;
  },
  with(this: any, index: any, value: any): any {
    const O = toObject(this);
    const len = lengthOf(O);
    const rel = toIntegerOrInfinity(index);
    const actual = rel >= 0 ? rel : len + rel;
    if (actual >= len || actual < 0) throw new RangeError(`Invalid index : ${String(index)}`);
    const A = arrayCreate(len);
    for (let k = 0; k < len; k++) A[k] = k === actual ? value : O[k];
    return A;
  },
};

const builtinSort = proto.sort;
// the runtime's methods reach the table for an array with a hole, once a prototype has an element
for (const name of Object.keys(generic)) (arrayMethods as any)[name] = generic[name];
host.trackProtoElements();
// name -> the `length` of the method
const lengths: { [name: string]: number } = {
  at: 1, concat: 1, copyWithin: 2, every: 1, fill: 1, filter: 1, find: 1, findIndex: 1, findLast: 1, findLastIndex: 1, flat: 0,
  flatMap: 1, forEach: 1, includes: 1, indexOf: 1, join: 1, lastIndexOf: 1, map: 1, pop: 0, push: 1, reduce: 1, reduceRight: 1,
  reverse: 0, shift: 0, slice: 2, some: 1, sort: 1, splice: 2, toLocaleString: 0, toReversed: 0, toSorted: 1, toSpliced: 2,
  toString: 0, unshift: 1, with: 2,
};
const convertsArguments = new Set(["at", "copyWithin", "fill", "flat", "includes", "indexOf", "join", "lastIndexOf", "slice", "splice", "toSpliced", "with"]);
for (const name of Object.keys(lengths)) {
  const builtin = proto[name], spec = generic[name];
  const holder = {
    m(this: any, ...args: any[]): any {
      // an object among the arguments converts in the specification's order, with the length read before it
      const direct = name !== "toLocaleString" && host.isPlainArray(this) &&
        !(convertsArguments.has(name) && args.some((a) => typeof a === "object" && a !== null));
      return direct ? builtin.apply(this, args) : spec.apply(this, args);
    },
  };
  const method = holder.m;
  Object.defineProperty(method, "name", { value: name, configurable: true });
  Object.defineProperty(method, "length", { value: lengths[name], configurable: true });
  host.replaceMethod(proto, builtin, method);
  Object.defineProperty(proto, name, { value: method, writable: true, enumerable: false, configurable: true });
}
