// structuredClone (a program that names it compiles this): the HTML specification's StructuredSerialize over the
// values a program of this runtime holds, what V8's serializer refuses refused with the same message.
import { DOMException } from "./dom_exception";

const host = (globalThis as any).__garnet;
const refuse = (text: string): never => { throw new DOMException(`${text} could not be cloned.`, "DataCloneError"); };
const objectText = (v: any): string => {
  const c = v.constructor;
  return `#<${typeof c === "function" && c.name ? c.name : "Object"}>`;
};
const ERROR_KINDS: Record<string, any> = { EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
function cloneError(v: any, memory: Map<any, any>): any {
  const nameValue = v.name;
  const name = typeof nameValue === "string" && Object.prototype.hasOwnProperty.call(ERROR_KINDS, nameValue) ? nameValue : "Error";
  const out: any = new (name === "Error" ? Error : ERROR_KINDS[name])();
  memory.set(v, out);
  delete out.message;
  const message = Object.getOwnPropertyDescriptor(v, "message");
  if (message !== undefined && "value" in message) Object.defineProperty(out, "message", { value: `${message.value}`, writable: true, enumerable: false, configurable: true });
  const stack = v.stack;
  if (typeof stack === "string") out.stack = stack;
  const cause = Object.getOwnPropertyDescriptor(v, "cause");
  if (cause !== undefined && "value" in cause) Object.defineProperty(out, "cause", { value: clone(cause.value, memory), writable: true, enumerable: false, configurable: true });
  return out;
}
function cloneBuffer(v: any, memory: Map<any, any>): any {
  if (typeof SharedArrayBuffer === "function" && v instanceof SharedArrayBuffer) { memory.set(v, v); return v; }
  if (v.detached) refuse("An ArrayBuffer is detached and");
  const out = v.slice(0);
  memory.set(v, out);
  return out;
}
function clone(v: any, memory: Map<any, any>): any {
  if (typeof v === "symbol") refuse(String(v));
  if (typeof v === "function") refuse(Function.prototype.toString.call(v));
  if (typeof v !== "object" || v === null) return v;
  if (memory.has(v)) return memory.get(v);
  if (host.isProxy(v)) refuse("#<Object>");
  if (v instanceof Boolean || v instanceof Number || v instanceof String) { const out = Object(v.valueOf()); memory.set(v, out); return out; }
  if (typeof BigInt === "function" && Object.prototype.toString.call(v) === "[object BigInt]") { const out = Object(v.valueOf()); memory.set(v, out); return out; }
  if (v instanceof Date) { const out = new Date(v.getTime()); memory.set(v, out); return out; }
  if (v instanceof RegExp) { const out = new RegExp(v.source, v.flags); memory.set(v, out); return out; }
  if (host.isArrayBuffer(v)) return cloneBuffer(v, memory);
  if (ArrayBuffer.isView(v)) {
    const buffer = clone(v.buffer, memory);
    const out = new (v.constructor as any)(buffer, v.byteOffset, (v as any).length);
    memory.set(v, out);
    return out;
  }
  if (typeof DataView === "function" && v instanceof DataView) {
    const out = new DataView(clone(v.buffer, memory), v.byteOffset, v.byteLength);
    memory.set(v, out);
    return out;
  }
  if (v instanceof Error) return cloneError(v, memory);
  if (v instanceof Map) {
    const out = new Map();
    memory.set(v, out);
    for (const [k, x] of [...v]) out.set(clone(k, memory), clone(x, memory));
    return out;
  }
  if (v instanceof Set) {
    const out = new Set();
    memory.set(v, out);
    for (const x of [...v]) out.add(clone(x, memory));
    return out;
  }
  if (v instanceof WeakMap || v instanceof WeakSet || v instanceof Promise) refuse(objectText(v));
  const tag = Object.prototype.toString.call(v);
  if (tag === "[object WeakRef]" || tag === "[object Generator]" || tag === "[object AsyncGenerator]") refuse(objectText(v));
  const out: any = Array.isArray(v) ? new Array(v.length) : {};
  memory.set(v, out);
  for (const k of Object.keys(v)) {
    const x = clone(v[k], memory);
    Object.defineProperty(out, k, { value: x, writable: true, enumerable: true, configurable: true });
  }
  return out;
}
const fns = {
  structuredClone(value?: any, options?: any): any {
    if (arguments.length === 0) {
      const e: any = new TypeError('The "The value argument must be specified" argument must be specified');
      e.code = "ERR_MISSING_ARGS";
      throw e;
    }
    const transfer = options === undefined || options === null ? [] : options.transfer === undefined ? [] : [...options.transfer];
    for (const t of transfer) if (!host.isArrayBuffer(t)) throw new DOMException("Value not transferable.", "DataCloneError");
    const out = clone(value, new Map());
    for (const t of transfer) t.transfer();
    return out;
  },
};
Object.defineProperty(fns.structuredClone, "length", { value: 1, configurable: true });
export const structuredClone = fns.structuredClone;
