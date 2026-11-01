// Array.fromAsync (a program that names it compiles this): the specification's steps over `for await`, which closes an
// iterator as the specification's loop does and awaits a sync iterable's values.

const host = (globalThis as any).__garnet;
const isObject = (v: any): boolean => (typeof v === "object" && v !== null) || typeof v === "function";
function createData(A: any, k: number, value: any): void {
  Object.defineProperty(A, k, { value, writable: true, enumerable: true, configurable: true });
}
function lengthOf(O: any): number {
  const n = +O.length;
  const i = n !== n ? 0 : Math.trunc(n);
  return i <= 0 ? 0 : Math.min(i, 9007199254740991);
}
const steps = {
  async run(C: any, asyncItems: any, mapfn: any, thisArg: any): Promise<any> {
    const mapping = mapfn !== undefined;
    if (mapping && typeof mapfn !== "function") throw new TypeError(`${String(mapfn)} is not a function`);
    const asyncMethod = asyncItems === undefined || asyncItems === null ? undefined : asyncItems[Symbol.asyncIterator];
    const syncMethod = asyncMethod !== undefined && asyncMethod !== null || asyncItems === undefined || asyncItems === null ? undefined : asyncItems[Symbol.iterator];
    if ((asyncMethod !== undefined && asyncMethod !== null) || (syncMethod !== undefined && syncMethod !== null)) {
      const A = host.isConstructor(C) ? new C() : [];
      let k = 0;
      for await (const value of asyncItems) {
        const mapped = mapping ? await mapfn.call(thisArg, value, k) : value;
        createData(A, k, mapped);
        k++;
      }
      A.length = k;
      return A;
    }
    if (asyncItems === undefined || asyncItems === null) throw new TypeError(`${String(asyncItems)} is not iterable`);
    const arrayLike = Object(asyncItems);
    const len = lengthOf(arrayLike);
    const A = host.isConstructor(C) ? new C(len) : new Array(len);
    for (let k = 0; k < len; k++) {
      const value = await arrayLike[k];
      createData(A, k, mapping ? await mapfn.call(thisArg, value, k) : value);
    }
    A.length = len;
    return A;
  },
};
// a built-in, not an async function: its prototype is Function.prototype and it returns the promise of the steps
const holder = {
  fromAsync(this: any, asyncItems: any, mapfn?: any, thisArg?: any): Promise<any> { return steps.run(this, asyncItems, mapfn, thisArg); },
};
Object.defineProperty(holder.fromAsync, "length", { value: 1, configurable: true });
Object.defineProperty(Array, "fromAsync", { value: holder.fromAsync, writable: true, enumerable: false, configurable: true });
