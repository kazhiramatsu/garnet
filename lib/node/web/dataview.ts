// DataView over an ArrayBuffer (docs/web_fetch_api_design.md): a Uint8Array view of the buffer's
// range; the floats go through a Float64Array and a Float32Array sharing one scratch buffer with
// a Uint8Array. The prelude installs the class as the global `DataView` when the program names it;
// under the V8 oracle the global is Node's own.

const scratch = new ArrayBuffer(8);
const scratchBytes = new Uint8Array(scratch);
const scratchF64 = new Float64Array(scratch);
const scratchF32 = new Float32Array(scratch);
// the global exists when the program names it: a DataView alone does not bring it in, so it is read on first use
let scratchF16Cached: any;
const scratchF16 = (): any => scratchF16Cached ??= new (globalThis as any).Float16Array(scratch);
// the platform's byte order, read once: the scratch bytes of 1.0
scratchF64[0] = 1;
const PLATFORM_LITTLE = scratchBytes[7] === 0x3f;

// ToIndex. `+v` is ToNumber: a BigInt and a Symbol throw.
function toIndex(v: any, what: string): number {
  const d = +v;
  const n = d !== d ? 0 : Math.trunc(d);
  if (n < 0 || n > 9007199254740991) throw new RangeError(what === "Offset" ? "Offset is outside the bounds of the DataView" : `${what} ${String(v)} is outside the bounds of the buffer`);
  return n;
}
const host = (globalThis as any).__garnet;

export class DataView {
  #buffer: any;
  #bytes: Uint8Array;
  #offset: number;
  #length: number;
  #tracking: boolean;
  constructor(buffer: any, byteOffset: any = undefined, byteLength: any = undefined) {
    if (!host.isArrayBuffer(buffer)) throw new TypeError("First argument to DataView constructor must be an ArrayBuffer");
    const off = toIndex(byteOffset, "Start offset");
    if (buffer.detached) throw new TypeError("Cannot perform DataView constructor on a detached ArrayBuffer");
    let total: number = buffer.byteLength;
    if (off > total) throw new RangeError(`Start offset ${off} is outside the bounds of the buffer`);
    const tracking = byteLength === undefined && (buffer.resizable === true || buffer.growable === true);
    let len = 0;
    if (byteLength === undefined) len = total - off;
    else {
      len = toIndex(byteLength, "Invalid DataView length");
      if (off + len > total) throw new RangeError(`Invalid DataView length ${len}`);
    }
    if (buffer.detached) throw new TypeError("Cannot perform DataView constructor on a detached ArrayBuffer");
    total = buffer.byteLength;
    if (off > total || (!tracking && off + len > total)) throw new RangeError(`Invalid DataView length ${len}`);
    this.#buffer = buffer;
    this.#offset = off;
    this.#length = len;
    this.#tracking = tracking;
    this.#bytes = new Uint8Array(buffer);
  }
  /** The view's length now: a detached buffer or a view out of bounds is a TypeError. */
  #viewLength(): number {
    const b = this.#buffer;
    if (b.detached) throw new TypeError("Cannot perform DataView method on a detached ArrayBuffer");
    const total: number = b.byteLength;
    if (this.#tracking) {
      if (this.#offset > total) throw new TypeError("Offset is outside the bounds of the DataView");
      return total - this.#offset;
    }
    if (this.#offset + this.#length > total) throw new TypeError("Offset is outside the bounds of the DataView");
    return this.#length;
  }
  get buffer(): any { return this.#buffer; }
  get byteLength(): number { return this.#viewLength(); }
  get byteOffset(): number { this.#viewLength(); return this.#offset; }
  /** The absolute index of `size` bytes at the converted `i`. */
  #at(i: number, size: number): number {
    if (i + size > this.#viewLength()) throw new RangeError("Offset is outside the bounds of the DataView");
    return i + this.#offset;
  }
  getInt8(byteOffset: any): number { const i = this.#at(toIndex(byteOffset, "Offset"), 1); const b = this.#bytes[i]; return b >= 128 ? b - 256 : b; }
  getUint8(byteOffset: any): number { const i = this.#at(toIndex(byteOffset, "Offset"), 1); return this.#bytes[i]; }
  getInt16(byteOffset: any, littleEndian: any = undefined): number { const v = this.getUint16(byteOffset, littleEndian); return v >= 0x8000 ? v - 0x10000 : v; }
  getUint16(byteOffset: any, littleEndian: any = undefined): number {
    const at = toIndex(byteOffset, "Offset");
    const little = !!littleEndian;
    const i = this.#at(at, 2); const b = this.#bytes;
    return little ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1];
  }
  getInt32(byteOffset: any, littleEndian: any = undefined): number { return this.getUint32(byteOffset, littleEndian) | 0; }
  getUint32(byteOffset: any, littleEndian: any = undefined): number {
    const at = toIndex(byteOffset, "Offset");
    const little = !!littleEndian;
    const i = this.#at(at, 4); const b = this.#bytes;
    return little
      ? (b[i] + b[i + 1] * 0x100 + b[i + 2] * 0x10000 + b[i + 3] * 0x1000000)
      : (b[i] * 0x1000000 + b[i + 1] * 0x10000 + b[i + 2] * 0x100 + b[i + 3]);
  }
  getFloat16(byteOffset: any, littleEndian: any = undefined): number {
    const at = toIndex(byteOffset, "Offset");
    const little = !!littleEndian;
    this.#load(this.#at(at, 2), 2, little);
    return scratchF16()[0];
  }
  getFloat32(byteOffset: any, littleEndian: any = undefined): number {
    const at = toIndex(byteOffset, "Offset");
    const little = !!littleEndian;
    this.#load(this.#at(at, 4), 4, little);
    return scratchF32[0];
  }
  getFloat64(byteOffset: any, littleEndian: any = undefined): number {
    const at = toIndex(byteOffset, "Offset");
    const little = !!littleEndian;
    this.#load(this.#at(at, 8), 8, little);
    return scratchF64[0];
  }
  #big(byteOffset: any, littleEndian: any): Uint8Array {
    const at = toIndex(byteOffset, "Offset");
    const little = !!littleEndian;
    const i = this.#at(at, 8);
    const t = new Uint8Array(8);
    for (let k = 0; k < 8; k++) t[k] = this.#bytes[little ? i + k : i + 7 - k];
    return t;
  }
  getBigInt64(byteOffset: any, littleEndian: any = undefined): bigint { return new BigInt64Array(this.#big(byteOffset, littleEndian).buffer)[0]; }
  getBigUint64(byteOffset: any, littleEndian: any = undefined): bigint { return new BigUint64Array(this.#big(byteOffset, littleEndian).buffer)[0]; }
  setInt8(byteOffset: any, value: any): void { this.setUint8(byteOffset, value); }
  setUint8(byteOffset: any, value: any): void {
    const at = toIndex(byteOffset, "Offset");
    const v = (+value | 0) & 0xff;
    this.#bytes[this.#at(at, 1)] = v;
  }
  setInt16(byteOffset: any, value: any, littleEndian: any = undefined): void { this.setUint16(byteOffset, value, littleEndian); }
  setUint16(byteOffset: any, value: any, littleEndian: any = undefined): void {
    const at = toIndex(byteOffset, "Offset");
    const v = (+value | 0) & 0xffff;
    const little = !!littleEndian;
    const i = this.#at(at, 2); const b = this.#bytes;
    if (little) { b[i] = v & 0xff; b[i + 1] = v >>> 8; } else { b[i] = v >>> 8; b[i + 1] = v & 0xff; }
  }
  setInt32(byteOffset: any, value: any, littleEndian: any = undefined): void { this.setUint32(byteOffset, value, littleEndian); }
  setUint32(byteOffset: any, value: any, littleEndian: any = undefined): void {
    const at = toIndex(byteOffset, "Offset");
    const v = (+value | 0) >>> 0;
    const little = !!littleEndian;
    const i = this.#at(at, 4); const b = this.#bytes;
    if (little) { b[i] = v & 0xff; b[i + 1] = (v >>> 8) & 0xff; b[i + 2] = (v >>> 16) & 0xff; b[i + 3] = v >>> 24; }
    else { b[i] = v >>> 24; b[i + 1] = (v >>> 16) & 0xff; b[i + 2] = (v >>> 8) & 0xff; b[i + 3] = v & 0xff; }
  }
  setFloat16(byteOffset: any, value: any, littleEndian: any = undefined): void {
    const at = toIndex(byteOffset, "Offset");
    const v = +value;
    const little = !!littleEndian;
    const i = this.#at(at, 2); scratchF16()[0] = v; this.#store(i, 2, little);
  }
  setFloat32(byteOffset: any, value: any, littleEndian: any = undefined): void {
    const at = toIndex(byteOffset, "Offset");
    const v = +value;
    const little = !!littleEndian;
    const i = this.#at(at, 4); scratchF32[0] = v; this.#store(i, 4, little);
  }
  setFloat64(byteOffset: any, value: any, littleEndian: any = undefined): void {
    const at = toIndex(byteOffset, "Offset");
    const v = +value;
    const little = !!littleEndian;
    const i = this.#at(at, 8); scratchF64[0] = v; this.#store(i, 8, little);
  }
  #setBig(at: number, b: Uint8Array, littleEndian: any): void {
    const little = !!littleEndian;
    const i = this.#at(at, 8);
    for (let k = 0; k < 8; k++) this.#bytes[little ? i + k : i + 7 - k] = b[k];
  }
  setBigInt64(byteOffset: any, value: any, littleEndian: any = undefined): void {
    const at = toIndex(byteOffset, "Offset");
    const b = new BigInt64Array(1); b[0] = value;
    this.#setBig(at, new Uint8Array(b.buffer), littleEndian);
  }
  setBigUint64(byteOffset: any, value: any, littleEndian: any = undefined): void {
    const at = toIndex(byteOffset, "Offset");
    const b = new BigUint64Array(1); b[0] = value;
    this.#setBig(at, new Uint8Array(b.buffer), littleEndian);
  }
  /** the scratch buffer's first `size` bytes from the view at `i`, in the platform's order */
  #load(i: number, size: number, littleEndian: boolean): void {
    const b = this.#bytes;
    if (littleEndian === PLATFORM_LITTLE) for (let k = 0; k < size; k++) scratchBytes[k] = b[i + k];
    else for (let k = 0; k < size; k++) scratchBytes[size - 1 - k] = b[i + k];
  }
  #store(i: number, size: number, littleEndian: boolean): void {
    const b = this.#bytes;
    if (littleEndian === PLATFORM_LITTLE) for (let k = 0; k < size; k++) b[i + k] = scratchBytes[k];
    else for (let k = 0; k < size; k++) b[i + k] = scratchBytes[size - 1 - k];
  }
}
Object.defineProperty(DataView.prototype, Symbol.toStringTag, { value: "DataView", writable: false, enumerable: false, configurable: true });
