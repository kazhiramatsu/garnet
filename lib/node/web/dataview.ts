// DataView over an ArrayBuffer (docs/web_fetch_api_design.md): a Uint8Array view of the buffer's
// range; the floats go through a Float64Array and a Float32Array sharing one scratch buffer with
// a Uint8Array. The prelude installs the class as the global `DataView` when the program names it;
// under the V8 oracle the global is Node's own.

const scratch = new ArrayBuffer(8);
const scratchBytes = new Uint8Array(scratch);
const scratchF64 = new Float64Array(scratch);
const scratchF32 = new Float32Array(scratch);
// the platform's byte order, read once: the scratch bytes of 1.0
scratchF64[0] = 1;
const PLATFORM_LITTLE = scratchBytes[7] === 0x3f;

function toIndex(v: unknown, what: string): number {
  if (v === undefined) return 0;
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  if (n < 0 || !Number.isFinite(n)) throw new RangeError(`${what} ${v} is outside the bounds of the buffer`);
  return Math.floor(n);
}

export class DataView {
  #buffer: ArrayBuffer;
  #bytes: Uint8Array;
  #offset: number;
  #length: number;
  constructor(buffer: ArrayBuffer, byteOffset?: number, byteLength?: number) {
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError("First argument to DataView constructor must be an ArrayBuffer");
    const off = toIndex(byteOffset, "Start offset");
    if (off > buffer.byteLength) throw new RangeError(`Start offset ${off} is outside the bounds of the buffer`);
    let len: number;
    if (byteLength === undefined) len = buffer.byteLength - off;
    else {
      len = toIndex(byteLength, "Invalid DataView length");
      if (off + len > buffer.byteLength) throw new RangeError(`Invalid DataView length ${len}`);
    }
    this.#buffer = buffer;
    this.#offset = off;
    this.#length = len;
    this.#bytes = new Uint8Array(buffer, off, len);
  }
  get buffer(): ArrayBuffer { return this.#buffer; }
  get byteLength(): number { return this.#length; }
  get byteOffset(): number { return this.#offset; }
  get [Symbol.toStringTag](): string { return "DataView"; }
  #at(byteOffset: unknown, size: number): number {
    const i = toIndex(byteOffset, "Offset");
    if (i + size > this.#length) throw new RangeError("Offset is outside the bounds of the DataView");
    return i;
  }
  getInt8(byteOffset: number): number { const i = this.#at(byteOffset, 1); const b = this.#bytes[i]; return b >= 128 ? b - 256 : b; }
  getUint8(byteOffset: number): number { const i = this.#at(byteOffset, 1); return this.#bytes[i]; }
  getInt16(byteOffset: number, littleEndian?: boolean): number { const v = this.getUint16(byteOffset, littleEndian); return v >= 0x8000 ? v - 0x10000 : v; }
  getUint16(byteOffset: number, littleEndian?: boolean): number {
    const i = this.#at(byteOffset, 2); const b = this.#bytes;
    return littleEndian ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1];
  }
  getInt32(byteOffset: number, littleEndian?: boolean): number { return this.getUint32(byteOffset, littleEndian) | 0; }
  getUint32(byteOffset: number, littleEndian?: boolean): number {
    const i = this.#at(byteOffset, 4); const b = this.#bytes;
    return littleEndian
      ? (b[i] + b[i + 1] * 0x100 + b[i + 2] * 0x10000 + b[i + 3] * 0x1000000)
      : (b[i] * 0x1000000 + b[i + 1] * 0x10000 + b[i + 2] * 0x100 + b[i + 3]);
  }
  getFloat32(byteOffset: number, littleEndian?: boolean): number {
    const i = this.#at(byteOffset, 4);
    this.#load(i, 4, littleEndian === true);
    return scratchF32[0];
  }
  getFloat64(byteOffset: number, littleEndian?: boolean): number {
    const i = this.#at(byteOffset, 8);
    this.#load(i, 8, littleEndian === true);
    return scratchF64[0];
  }
  getBigInt64(): never { throw new TypeError("BigInt is not supported"); }
  getBigUint64(): never { throw new TypeError("BigInt is not supported"); }
  setInt8(byteOffset: number, value: number): void { const i = this.#at(byteOffset, 1); this.#bytes[i] = (Number(value) | 0) & 0xff; }
  setUint8(byteOffset: number, value: number): void { const i = this.#at(byteOffset, 1); this.#bytes[i] = (Number(value) | 0) & 0xff; }
  setInt16(byteOffset: number, value: number, littleEndian?: boolean): void { this.setUint16(byteOffset, value, littleEndian); }
  setUint16(byteOffset: number, value: number, littleEndian?: boolean): void {
    const i = this.#at(byteOffset, 2); const v = (Number(value) | 0) & 0xffff; const b = this.#bytes;
    if (littleEndian) { b[i] = v & 0xff; b[i + 1] = v >>> 8; } else { b[i] = v >>> 8; b[i + 1] = v & 0xff; }
  }
  setInt32(byteOffset: number, value: number, littleEndian?: boolean): void { this.setUint32(byteOffset, value, littleEndian); }
  setUint32(byteOffset: number, value: number, littleEndian?: boolean): void {
    const i = this.#at(byteOffset, 4); const v = (Number(value) | 0) >>> 0; const b = this.#bytes;
    if (littleEndian) { b[i] = v & 0xff; b[i + 1] = (v >>> 8) & 0xff; b[i + 2] = (v >>> 16) & 0xff; b[i + 3] = v >>> 24; }
    else { b[i] = v >>> 24; b[i + 1] = (v >>> 16) & 0xff; b[i + 2] = (v >>> 8) & 0xff; b[i + 3] = v & 0xff; }
  }
  setFloat32(byteOffset: number, value: number, littleEndian?: boolean): void {
    const i = this.#at(byteOffset, 4); scratchF32[0] = Number(value); this.#store(i, 4, littleEndian === true);
  }
  setFloat64(byteOffset: number, value: number, littleEndian?: boolean): void {
    const i = this.#at(byteOffset, 8); scratchF64[0] = Number(value); this.#store(i, 8, littleEndian === true);
  }
  setBigInt64(): never { throw new TypeError("BigInt is not supported"); }
  setBigUint64(): never { throw new TypeError("BigInt is not supported"); }
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
