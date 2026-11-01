// Promise's protocol as the specification writes it (docs/promise_protocol_design.md): NewPromiseCapability over any
// constructor, `resolve` and `then` read from the objects, species. A program compiles this module only when it can tell: it
// extends Promise, borrows a static with `.call`, replaces `then` or `resolve`. Any other program keeps the runtime's direct
// paths, which agree for an unmodified Promise.

import "./species";

const host = (globalThis as any).__garnet;
const NativePromise: any = Promise;
const nativeThen = NativePromise.prototype.then;
const isObject = (v: any): boolean => (typeof v === "object" && v !== null) || typeof v === "function";

function newPromiseCapability(C: any): any {
  if (!host.isConstructor(C)) throw new TypeError("Promise resolve or reject function is not callable");
  const cap: any = { promise: undefined, resolve: undefined, reject: undefined };
  const promise = new C(anonymous((resolve: any, reject: any) => {
    if (cap.resolve !== undefined || cap.reject !== undefined) throw new TypeError("Promise executor has already been invoked with non-undefined arguments");
    cap.resolve = resolve;
    cap.reject = reject;
  }));
  if (typeof cap.resolve !== "function" || typeof cap.reject !== "function") throw new TypeError("Promise resolve or reject function is not callable");
  cap.promise = promise;
  return cap;
}
function anonymous(fn: any): any {
  Object.defineProperty(fn, "name", { value: "", configurable: true });
  return fn;
}
function promiseResolve(C: any, x: any): any {
  if (host.isPromise(x) && x.constructor === C) return x;
  const cap = newPromiseCapability(C);
  cap.resolve(x);
  return cap.promise;
}
function speciesConstructor(O: any, defaultConstructor: any): any {
  const C = O.constructor;
  if (C === undefined) return defaultConstructor;
  if (!isObject(C)) throw new TypeError("The .constructor property is not an object");
  const S = C[Symbol.species];
  if (S === undefined || S === null) return defaultConstructor;
  if (!host.isConstructor(S)) throw new TypeError("object.constructor[Symbol.species] is not a constructor");
  return S;
}
// The loop of the four combinators: GetPromiseResolve, GetIterator, and what becomes of an abrupt completion.
const STOP = {};
function combine(C: any, iterable: any, perform: (cap: any, step: () => any, resolveFn: any) => void): any {
  const cap = newPromiseCapability(C);
  let resolveFn: any, iterator: any, next: any;
  try {
    resolveFn = C.resolve;
    if (typeof resolveFn !== "function") throw new TypeError("Promise resolve or reject function is not callable");
    const method = iterable[Symbol.iterator];
    if (typeof method !== "function") throw new TypeError(`${typeof iterable} is not iterable`);
    iterator = method.call(iterable);
    if (!isObject(iterator)) throw new TypeError("Result of the Symbol.iterator method is not an object");
    next = iterator.next;
  } catch (e) {
    cap.reject(e);
    return cap.promise;
  }
  let done = false;
  const step = (): any => {
    try {
      const r = next.call(iterator);
      if (!isObject(r)) throw new TypeError(`Iterator result ${String(r)} is not an object`);
      if (r.done) {
        done = true;
        return STOP;
      }
      return r.value;
    } catch (e) {
      done = true;
      throw e;
    }
  };
  try {
    perform(cap, step, resolveFn);
  } catch (e) {
    if (!done) {
      try {
        const ret = iterator.return;
        if (ret !== undefined && ret !== null) ret.call(iterator);
      } catch (_) { /* the first completion stands */ }
    }
    cap.reject(e);
  }
  return cap.promise;
}

const statics: any = {
  all(this: any, iterable: any): any {
    const C = this;
    return combine(C, iterable, (cap, step, resolveFn) => {
      const values: any[] = [];
      let remaining = 1;
      for (let index = 0; ; index++) {
        const item = step();
        if (item === STOP) {
          if (--remaining === 0) cap.resolve(values);
          return;
        }
        values.push(undefined);
        const nextPromise = resolveFn.call(C, item);
        let called = false;
        remaining++;
        nextPromise.then((x: any) => {
          if (called) return undefined;
          called = true;
          values[index] = x;
          if (--remaining === 0) return cap.resolve(values);
          return undefined;
        }, cap.reject);
      }
    });
  },
  allSettled(this: any, iterable: any): any {
    const C = this;
    return combine(C, iterable, (cap, step, resolveFn) => {
      const values: any[] = [];
      let remaining = 1;
      for (let index = 0; ; index++) {
        const item = step();
        if (item === STOP) {
          if (--remaining === 0) cap.resolve(values);
          return;
        }
        values.push(undefined);
        const nextPromise = resolveFn.call(C, item);
        let called = false;
        remaining++;
        nextPromise.then((x: any) => {
          if (called) return undefined;
          called = true;
          values[index] = { status: "fulfilled", value: x };
          if (--remaining === 0) return cap.resolve(values);
          return undefined;
        }, (x: any) => {
          if (called) return undefined;
          called = true;
          values[index] = { status: "rejected", reason: x };
          if (--remaining === 0) return cap.resolve(values);
          return undefined;
        });
      }
    });
  },
  any(this: any, iterable: any): any {
    const C = this;
    return combine(C, iterable, (cap, step, resolveFn) => {
      const errors: any[] = [];
      let remaining = 1;
      const rejectAll = (): any => {
        const error: any = new (globalThis as any).AggregateError([], "All promises were rejected");
        Object.defineProperty(error, "errors", { value: errors, writable: true, enumerable: false, configurable: true });
        return error;
      };
      for (let index = 0; ; index++) {
        const item = step();
        if (item === STOP) {
          if (--remaining === 0) throw rejectAll();
          return;
        }
        errors.push(undefined);
        const nextPromise = resolveFn.call(C, item);
        let called = false;
        remaining++;
        nextPromise.then(cap.resolve, (x: any) => {
          if (called) return undefined;
          called = true;
          errors[index] = x;
          if (--remaining === 0) return cap.reject(rejectAll());
          return undefined;
        });
      }
    });
  },
  race(this: any, iterable: any): any {
    const C = this;
    return combine(C, iterable, (cap, step, resolveFn) => {
      for (;;) {
        const item = step();
        if (item === STOP) return;
        resolveFn.call(C, item).then(cap.resolve, cap.reject);
      }
    });
  },
  resolve(this: any, x: any): any {
    if (!isObject(this)) throw new TypeError("PromiseResolve called on non-object");
    return promiseResolve(this, x);
  },
  reject(this: any, r: any): any {
    const cap = newPromiseCapability(this);
    cap.reject(r);
    return cap.promise;
  },
  withResolvers(this: any): any {
    const cap = newPromiseCapability(this);
    return { promise: cap.promise, resolve: cap.resolve, reject: cap.reject };
  },
  try(this: any, callback: any, ...args: any[]): any {
    if (!isObject(this)) throw new TypeError("Promise.try called on non-object");
    const cap = newPromiseCapability(this);
    try {
      cap.resolve(callback(...args));
    } catch (e) {
      cap.reject(e);
    }
    return cap.promise;
  },
};
Object.defineProperty(statics.try, "length", { value: 1, configurable: true });
for (const name of Object.keys(statics)) {
  Object.defineProperty(NativePromise, name, { value: statics[name], writable: true, enumerable: false, configurable: true });
}

// A reaction of a promise of another constructor: the handler's result settles that capability.
function reaction(handler: any, cap: any, rejecting: boolean): any {
  return (value: any): void => {
    let result: any;
    try {
      if (typeof handler !== "function") {
        if (rejecting) throw value;
        result = value;
      } else result = handler(value);
    } catch (e) {
      cap.reject(e);
      return;
    }
    cap.resolve(result);
  };
}
const prototype: any = {
  then(this: any, onFulfilled: any, onRejected: any): any {
    if (!host.isPromise(this)) throw new TypeError(`Method Promise.prototype.then called on incompatible receiver ${String(this)}`);
    const C = speciesConstructor(this, NativePromise);
    if (C === NativePromise) return nativeThen.call(this, onFulfilled, onRejected);
    const cap = newPromiseCapability(C);
    nativeThen.call(this, reaction(onFulfilled, cap, false), reaction(onRejected, cap, true));
    return cap.promise;
  },
  catch(this: any, onRejected: any): any {
    return this.then(undefined, onRejected);
  },
  finally(this: any, onFinally: any): any {
    if (!isObject(this)) throw new TypeError("Promise.prototype.finally called on a non-object");
    const C = speciesConstructor(this, NativePromise);
    if (typeof onFinally !== "function") return this.then(onFinally, onFinally);
    const thenFinally = anonymous((value: any): any => promiseResolve(C, onFinally()).then(anonymous(() => value)));
    const catchFinally = anonymous((reason: any): any => promiseResolve(C, onFinally()).then(anonymous(() => { throw reason; })));
    return this.then(thenFinally, catchFinally);
  },
};
for (const name of ["then", "catch", "finally"]) {
  host.replaceMethod(NativePromise.prototype, NativePromise.prototype[name], prototype[name]);
  Object.defineProperty(NativePromise.prototype, name, { value: prototype[name], writable: true, enumerable: false, configurable: true });
}
