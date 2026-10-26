// node:buffer (docs/node_compat_design.md, N2). A Buffer is a Uint8Array view whose
// prototype is Buffer.prototype (methods over the typed array's), made by the
// factories; `Buffer` itself is a constructor object with Symbol.hasInstance, so
// `buf instanceof Buffer`, `buf instanceof Uint8Array` and the typed-array APIs all
// hold. The encodings are implemented here: utf8 through TextEncoder/TextDecoder,
// latin1, ascii, utf16le, base64, base64url and hex in TypeScript.
import { host } from "./host";
import { codedTypeError, codedRangeError, invalidArgType } from "./errors";

export type BufferEncoding = "ascii" | "utf8" | "utf-8" | "utf16le" | "utf-16le" | "ucs2" | "ucs-2" | "base64" | "base64url" | "latin1" | "binary" | "hex";
type Encoding = "utf8" | "utf16le" | "latin1" | "ascii" | "base64" | "base64url" | "hex";

export interface Buffer extends Uint8Array<ArrayBuffer> {
  toString(encoding?: string, start?: number, end?: number): string;
  toJSON(): { type: "Buffer"; data: number[] };
  write(string: string, offset?: number | string, length?: number | string, encoding?: string): number;
  equals(other: Uint8Array): boolean;
  compare(target: Uint8Array, targetStart?: number, targetEnd?: number, sourceStart?: number, sourceEnd?: number): number;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
  fill(value: string | number | Uint8Array, offset?: number | string, end?: number | string, encoding?: string): this;
  indexOf(value: string | number | Uint8Array, byteOffset?: number | string, encoding?: string): number;
  lastIndexOf(value: string | number | Uint8Array, byteOffset?: number | string, encoding?: string): number;
  includes(value: string | number | Uint8Array, byteOffset?: number | string, encoding?: string): boolean;
  readUInt8(offset?: number): number; readUint8(offset?: number): number;
  readInt8(offset?: number): number;
  readUInt16LE(offset?: number): number; readUint16LE(offset?: number): number;
  readUInt16BE(offset?: number): number; readUint16BE(offset?: number): number;
  readInt16LE(offset?: number): number; readInt16BE(offset?: number): number;
  readUInt32LE(offset?: number): number; readUint32LE(offset?: number): number;
  readUInt32BE(offset?: number): number; readUint32BE(offset?: number): number;
  readInt32LE(offset?: number): number; readInt32BE(offset?: number): number;
  readUIntLE(offset: number, byteLength: number): number; readUintLE(offset: number, byteLength: number): number;
  readUIntBE(offset: number, byteLength: number): number; readUintBE(offset: number, byteLength: number): number;
  readIntLE(offset: number, byteLength: number): number; readIntBE(offset: number, byteLength: number): number;
  readFloatLE(offset?: number): number; readFloatBE(offset?: number): number;
  readDoubleLE(offset?: number): number; readDoubleBE(offset?: number): number;
  writeUInt8(value: number, offset?: number): number; writeUint8(value: number, offset?: number): number;
  writeInt8(value: number, offset?: number): number;
  writeUInt16LE(value: number, offset?: number): number; writeUint16LE(value: number, offset?: number): number;
  writeUInt16BE(value: number, offset?: number): number; writeUint16BE(value: number, offset?: number): number;
  writeInt16LE(value: number, offset?: number): number; writeInt16BE(value: number, offset?: number): number;
  writeUInt32LE(value: number, offset?: number): number; writeUint32LE(value: number, offset?: number): number;
  writeUInt32BE(value: number, offset?: number): number; writeUint32BE(value: number, offset?: number): number;
  writeInt32LE(value: number, offset?: number): number; writeInt32BE(value: number, offset?: number): number;
  writeUIntLE(value: number, offset: number, byteLength: number): number; writeUintLE(value: number, offset: number, byteLength: number): number;
  writeUIntBE(value: number, offset: number, byteLength: number): number; writeUintBE(value: number, offset: number, byteLength: number): number;
  writeIntLE(value: number, offset: number, byteLength: number): number; writeIntBE(value: number, offset: number, byteLength: number): number;
  writeFloatLE(value: number, offset?: number): number; writeFloatBE(value: number, offset?: number): number;
  writeDoubleLE(value: number, offset?: number): number; writeDoubleBE(value: number, offset?: number): number;
  swap16(): this; swap32(): this; swap64(): this;
  reverse(): this;
}
export interface BufferConstructor {
  from(value: string, encoding?: string): Buffer;
  from(value: ArrayLike<number> | Uint8Array | ArrayBuffer | SharedArrayBuffer | { type: "Buffer"; data: number[] }, byteOffsetOrEncoding?: number | string, length?: number): Buffer;
  alloc(size: number, fill?: string | number | Uint8Array, encoding?: string): Buffer;
  allocUnsafe(size: number): Buffer;
  allocUnsafeSlow(size: number): Buffer;
  byteLength(value: string | ArrayBufferView | ArrayBuffer, encoding?: string): number;
  isBuffer(value: unknown): value is Buffer;
  isEncoding(encoding: string): boolean;
  concat(list: Uint8Array[], totalLength?: number): Buffer;
  compare(a: Uint8Array, b: Uint8Array): number;
  copyBytesFrom(view: ArrayBufferView, offset?: number, length?: number): Buffer;
  poolSize: number;
  readonly prototype: Buffer;
  [Symbol.hasInstance](value: unknown): boolean;
}

// Buffer.prototype: an object over Uint8Array's prototype (host.createObject: never a class chain,
// so the program's receivers stay closed, docs/closed_receivers_design.md)
const proto = host.createObject(Uint8Array.prototype) as { [name: string]: unknown };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });   // buf.toString() keeps a leading BOM, as Node does

function adopt(view: Uint8Array): Buffer {
  host.relink(view, proto);
  return view as Buffer;
}
function isBufferValue(v: unknown): v is Buffer { return v instanceof Uint8Array && Object.getPrototypeOf(v) === proto; }
/** The view itself as a Buffer (no copy): for bytes the host just produced. */
export function fromView(view: Uint8Array): Buffer { return adopt(view); }

export function normalizeEncoding(enc: string | undefined): Encoding | undefined {
  if (enc === undefined || enc === null || enc === "utf8" || enc === "utf-8") return "utf8";
  if (enc === "hex") return "hex";
  if (enc === "latin1" || enc === "binary") return "latin1";
  if (enc === "base64") return "base64";
  switch (enc.toLowerCase()) {
    case "utf8": case "utf-8": return "utf8";
    case "ucs2": case "ucs-2": case "utf16le": case "utf-16le": return "utf16le";
    case "latin1": case "binary": return "latin1";
    case "ascii": return "ascii";
    case "base64": return "base64";
    case "base64url": return "base64url";
    case "hex": return "hex";
    default: return undefined;
  }
}
function encodingOf(enc: string | undefined): Encoding {
  const e = normalizeEncoding(enc);
  if (e === undefined) throw codedTypeError("ERR_UNKNOWN_ENCODING", "Unknown encoding: " + enc);
  return e;
}

// ---- encoding ----
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_VALUE: number[] = [];
for (let i = 0; i < 256; i++) B64_VALUE.push(-1);
for (let i = 0; i < 64; i++) { B64_VALUE[B64.charCodeAt(i)] = i; B64_VALUE[B64URL.charCodeAt(i)] = i; }

function encodeString(s: string, enc: Encoding): Uint8Array {
  switch (enc) {
    case "utf8": return encoder.encode(s);
    case "latin1": case "ascii": {
      const out = new Uint8Array(s.length);
      host.writeString(s, out, 0, out.length, 2);
      return out;
    }
    case "utf16le": {
      const out = new Uint8Array(s.length * 2);
      host.writeString(s, out, 0, out.length, 1);
      return out;
    }
    case "hex": {
      let n = 0;
      const out = new Uint8Array(s.length >>> 1);
      for (let i = 0; i + 1 < s.length; i += 2) {
        const hi = hexValue(s.charCodeAt(i)), lo = hexValue(s.charCodeAt(i + 1));
        if (hi < 0 || lo < 0) break;   // Node stops at the first invalid pair
        out[n++] = hi * 16 + lo;
      }
      return n === out.length ? out : out.subarray(0, n);
    }
    case "base64": case "base64url": {
      const out = new Uint8Array(base64DecodedLength(s));
      let n = 0, acc = 0, bits = 0;
      for (let i = 0; i < s.length; i++) {
        const v = B64_VALUE[s.charCodeAt(i) & 255];
        if (v < 0) { if (s.charCodeAt(i) === 61) break; continue; }   // '=' ends, other characters are skipped
        acc = (acc << 6) | v; bits += 6;
        if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 255; }
      }
      return n === out.length ? out : out.subarray(0, n);
    }
  }
}
function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}
function base64DecodedLength(s: string): number {
  let len = s.length;
  while (len > 0 && (s.charCodeAt(len - 1) === 61 || s.charCodeAt(len - 1) === 10 || s.charCodeAt(len - 1) === 13 || s.charCodeAt(len - 1) === 32)) len--;
  return (len * 3) >>> 2;
}
function decodeBytes(b: Uint8Array, enc: Encoding, start: number, end: number): string {
  const view = start === 0 && end === b.length ? b : b.subarray(start, end);
  switch (enc) {
    case "utf8": return decoder.decode(view);
    case "latin1": { let s = ""; for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]); return s; }
    case "ascii": { let s = ""; for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i] & 127); return s; }
    case "utf16le": { let s = ""; for (let i = 0; i + 1 < view.length; i += 2) s += String.fromCharCode(view[i] | (view[i + 1] << 8)); return s; }
    case "hex": { let s = ""; for (let i = 0; i < view.length; i++) { const v = view[i]; s += "0123456789abcdef"[v >> 4] + "0123456789abcdef"[v & 15]; } return s; }
    case "base64": case "base64url": {
      const table = enc === "base64" ? B64 : B64URL;
      let s = "";
      let i = 0;
      for (; i + 2 < view.length; i += 3) {
        const n = (view[i] << 16) | (view[i + 1] << 8) | view[i + 2];
        s += table[(n >> 18) & 63] + table[(n >> 12) & 63] + table[(n >> 6) & 63] + table[n & 63];
      }
      if (i < view.length) {
        const n = (view[i] << 16) | (i + 1 < view.length ? view[i + 1] << 8 : 0);
        s += table[(n >> 18) & 63] + table[(n >> 12) & 63];
        if (i + 1 < view.length) { s += table[(n >> 6) & 63]; if (enc === "base64") s += "="; }
        else if (enc === "base64") s += "==";
      }
      return s;
    }
  }
}
function byteLengthOf(s: string, enc: Encoding): number {
  switch (enc) {
    case "utf8": return host.utf8Length(s);
    case "latin1": case "ascii": return s.length;
    case "utf16le": return s.length * 2;
    case "hex": return s.length >>> 1;
    case "base64": case "base64url": return base64DecodedLength(s);
  }
}

// ---- argument checks (Node's errors) ----
function addNumericalSeparator(v: string): string {
  let res = "";
  let i = v.length;
  const start = v.charCodeAt(0) === 45 ? 1 : 0;   // a leading minus
  for (; i >= start + 4; i -= 3) res = "_" + v.slice(i - 3, i) + res;
  return v.slice(0, i) + res;
}
function checkInt(value: number, min: number, max: number, buf: Uint8Array, offset: number, byteLength: number): void {
  if (value > max || value < min) {
    const n = typeof min === "number" && Math.abs(min) > 4294967295 || Math.abs(max) > 4294967295;
    let range: string;
    if (byteLength > 3) {
      if (min === 0 || min === 0 && !n) range = ">= 0 and < 2 ** " + (byteLength * 8); // eslint-disable-line no-constant-condition
      else range = ">= -(2 ** " + (byteLength * 8 - 1) + ") and < 2 ** " + (byteLength * 8 - 1);
      if (min === 0) range = ">= 0 and < 2 ** " + (byteLength * 8);
    } else {
      range = ">= " + min + " and <= " + max;
    }
    throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"value\" is out of range. It must be " + range + ". Received " + addNumericalSeparator(String(value)));
  }
  checkBounds(buf, offset, byteLength);
}
function checkBounds(buf: Uint8Array, offset: number, byteLength: number): void {
  if (typeof offset !== "number") throw invalidArgType("offset", "of type number", offset);
  if (Math.floor(offset) !== offset) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"offset\" is out of range. It must be an integer. Received " + offset);
  if (buf.length < byteLength) throw codedRangeError("ERR_BUFFER_OUT_OF_BOUNDS", "Attempt to access memory outside buffer bounds");
  if (offset < 0 || offset > buf.length - byteLength) {
    throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"offset\" is out of range. It must be >= 0 and <= " + (buf.length - byteLength) + ". Received " + offset);
  }
}
function toOffset(v: number | undefined): number { return v === undefined ? 0 : v; }

// ---- the prototype's methods ----
function defineMethod(name: string, fn: unknown): void { proto[name] = fn; }
defineMethod("toString", function (this: Uint8Array, encoding?: string, start?: number, end?: number): string {
  const len = this.length;
  let s = start === undefined ? 0 : Math.max(0, Math.floor(start));
  let e = end === undefined ? len : Math.min(len, Math.floor(end));
  if (s >= len || e <= s) return "";
  if (s < 0) s = 0;
  return decodeBytes(this, encodingOf(encoding), s, e);
});
proto.toLocaleString = proto.toString;
defineMethod("toJSON", function (this: Uint8Array): { type: "Buffer"; data: number[] } {
  const data: number[] = [];
  for (let i = 0; i < this.length; i++) data.push(this[i]);
  return { type: "Buffer", data };
});
defineMethod("write", function (this: Uint8Array, string: string, offset?: number | string, length?: number | string, encoding?: string): number {
  if (typeof string !== "string") throw invalidArgType("argument", "of type string", string);
  let off = 0, len = this.length, enc: string | undefined = undefined;
  if (typeof offset === "string") { enc = offset; }
  else if (offset !== undefined) {
    off = offset;
    if (typeof length === "string") enc = length;
    else if (length !== undefined) { len = length; enc = encoding; }
    else len = this.length - off;
  }
  if (off < 0 || off > this.length) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"offset\" is out of range. It must be >= 0 and <= " + this.length + ". Received " + off);
  const e = encodingOf(enc);
  const room = Math.min(len, this.length - off);
  // utf8, utf16le and latin1 are written by the host straight into the view (whole characters and units only)
  if (e === "utf8") return host.writeString(string, this, off, room, 0);
  if (e === "utf16le") return host.writeString(string, this, off, room, 1);
  if (e === "latin1" || e === "ascii") return host.writeString(string, this, off, room, 2);
  const bytes = encodeString(string, e);
  const n = Math.min(bytes.length, room);
  for (let i = 0; i < n; i++) this[off + i] = bytes[i];
  return n;
});
defineMethod("equals", function (this: Uint8Array, other: Uint8Array): boolean {
  if (!(other instanceof Uint8Array)) throw invalidArgType("otherBuffer", "an instance of Buffer or Uint8Array", other);
  if (this.length !== other.length) return false;
  for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
  return true;
});
function compareBytes(a: Uint8Array, aStart: number, aEnd: number, b: Uint8Array, bStart: number, bEnd: number): number {
  const n = Math.min(aEnd - aStart, bEnd - bStart);
  for (let i = 0; i < n; i++) {
    const x = a[aStart + i], y = b[bStart + i];
    if (x !== y) return x < y ? -1 : 1;
  }
  const la = aEnd - aStart, lb = bEnd - bStart;
  return la === lb ? 0 : la < lb ? -1 : 1;
}
defineMethod("compare", function (this: Uint8Array, target: Uint8Array, targetStart?: number, targetEnd?: number, sourceStart?: number, sourceEnd?: number): number {
  if (!(target instanceof Uint8Array)) throw invalidArgType("target", "an instance of Buffer or Uint8Array", target);
  return compareBytes(this, sourceStart === undefined ? 0 : sourceStart, sourceEnd === undefined ? this.length : sourceEnd,
    target, targetStart === undefined ? 0 : targetStart, targetEnd === undefined ? target.length : targetEnd);
});
defineMethod("copy", function (this: Uint8Array, target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number {
  if (!(target instanceof Uint8Array)) throw invalidArgType("target", "an instance of Buffer or Uint8Array", target);
  const ts = targetStart === undefined ? 0 : targetStart, ss = sourceStart === undefined ? 0 : sourceStart;
  const se = sourceEnd === undefined ? this.length : Math.min(sourceEnd, this.length);
  if (ts >= target.length || ss >= se) return 0;
  const n = Math.min(se - ss, target.length - ts);
  if (target === this && ts > ss) { for (let i = n - 1; i >= 0; i--) target[ts + i] = this[ss + i]; }
  else for (let i = 0; i < n; i++) target[ts + i] = this[ss + i];
  return n;
});
function clampIndex(v: number | undefined, len: number, dflt: number): number {
  if (v === undefined) return dflt;
  let i = Math.trunc(v);
  if (i !== i) i = 0;
  if (i < 0) { i += len; if (i < 0) i = 0; } else if (i > len) i = len;
  return i;
}
defineMethod("subarray", function (this: Uint8Array, start?: number, end?: number): Buffer {
  const s = clampIndex(start, this.length, 0), e = clampIndex(end, this.length, this.length);
  return adopt(new Uint8Array(this.buffer, this.byteOffset + s, Math.max(0, e - s)));
});
proto.slice = proto.subarray;
defineMethod("fill", function (this: Uint8Array, value: string | number | Uint8Array, offset?: number | string, end?: number | string, encoding?: string): Uint8Array {
  let off = 0, e = this.length, enc: string | undefined = encoding;
  if (typeof offset === "string") enc = offset;
  else if (offset !== undefined) { off = offset; if (typeof end === "string") enc = end; else if (end !== undefined) e = end; }
  if (off < 0 || off > this.length) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"offset\" is out of range. It must be >= 0 and <= " + this.length + ". Received " + off);
  if (e < 0 || e > this.length) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"end\" is out of range. It must be >= 0 and <= " + this.length + ". Received " + e);
  if (e <= off) return this;
  let bytes: Uint8Array;
  if (typeof value === "number") { for (let i = off; i < e; i++) this[i] = value & 255; return this; }
  else if (typeof value === "string") { bytes = encodeString(value, encodingOf(enc)); if (bytes.length === 0) { for (let i = off; i < e; i++) this[i] = 0; return this; } }
  else if (value instanceof Uint8Array) bytes = value;
  else throw invalidArgType("value", "of type string or an instance of Buffer or Uint8Array", value);
  for (let i = off, j = 0; i < e; i++, j = (j + 1) % bytes.length) this[i] = bytes[j];
  return this;
});
function needleBytes(value: string | number | Uint8Array, encoding: string | undefined): Uint8Array {
  if (typeof value === "string") return encodeString(value, encodingOf(encoding));
  if (typeof value === "number") return new Uint8Array([value & 255]);
  if (value instanceof Uint8Array) return value;
  throw invalidArgType("value", "one of type number or string or an instance of Buffer or Uint8Array", value);
}
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number, backwards: boolean): number {
  if (needle.length === 0) return backwards ? Math.min(from, hay.length) : Math.min(from, hay.length);
  const last = hay.length - needle.length;
  if (!backwards) {
    for (let i = Math.max(from, 0); i <= last; i++) {
      let k = 0;
      while (k < needle.length && hay[i + k] === needle[k]) k++;
      if (k === needle.length) return i;
    }
  } else {
    for (let i = Math.min(from, last); i >= 0; i--) {
      let k = 0;
      while (k < needle.length && hay[i + k] === needle[k]) k++;
      if (k === needle.length) return i;
    }
  }
  return -1;
}
function searchFrom(buf: Uint8Array, byteOffset: number | string | undefined, backwards: boolean): { from: number; enc: string | undefined } {
  if (typeof byteOffset === "string") return { from: backwards ? buf.length : 0, enc: byteOffset };
  let from = byteOffset === undefined ? (backwards ? buf.length : 0) : Math.trunc(byteOffset);
  if (from !== from) from = backwards ? buf.length : 0;
  if (from < 0) from += buf.length;
  return { from, enc: undefined };
}
defineMethod("indexOf", function (this: Uint8Array, value: string | number | Uint8Array, byteOffset?: number | string, encoding?: string): number {
  const s = searchFrom(this, byteOffset, false);
  return indexOfBytes(this, needleBytes(value, s.enc === undefined ? encoding : s.enc), s.from, false);
});
defineMethod("lastIndexOf", function (this: Uint8Array, value: string | number | Uint8Array, byteOffset?: number | string, encoding?: string): number {
  const s = searchFrom(this, byteOffset, true);
  return indexOfBytes(this, needleBytes(value, s.enc === undefined ? encoding : s.enc), s.from, true);
});
defineMethod("includes", function (this: Buffer, value: string | number | Uint8Array, byteOffset?: number | string, encoding?: string): boolean {
  return this.indexOf(value, byteOffset, encoding) !== -1;
});
// integers
function readUIntLE(buf: Uint8Array, offset: number, n: number): number {
  checkBounds(buf, offset, n);
  let v = 0, mul = 1;
  for (let i = 0; i < n; i++) { v += buf[offset + i] * mul; mul *= 256; }
  return v;
}
function readUIntBE(buf: Uint8Array, offset: number, n: number): number {
  checkBounds(buf, offset, n);
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + buf[offset + i];
  return v;
}
function signed(v: number, n: number): number { const limit = Math.pow(2, n * 8 - 1); return v >= limit ? v - 2 * limit : v; }
function writeUIntLE(buf: Uint8Array, value: number, offset: number, n: number, min: number, max: number): number {
  checkInt(value, min, max, buf, offset, n);
  let v = value < 0 ? value + Math.pow(2, n * 8) : value;
  for (let i = 0; i < n; i++) { buf[offset + i] = v % 256; v = Math.floor(v / 256); }
  return offset + n;
}
function writeUIntBE(buf: Uint8Array, value: number, offset: number, n: number, min: number, max: number): number {
  checkInt(value, min, max, buf, offset, n);
  let v = value < 0 ? value + Math.pow(2, n * 8) : value;
  for (let i = n - 1; i >= 0; i--) { buf[offset + i] = v % 256; v = Math.floor(v / 256); }
  return offset + n;
}
function checkByteLength(n: number): void {
  if (typeof n !== "number" || n !== Math.floor(n) || n < 1 || n > 6) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"byteLength\" is out of range. It must be >= 1 and <= 6. Received " + n);
}
defineMethod("readUInt8", function (this: Uint8Array, offset?: number): number { return readUIntLE(this, toOffset(offset), 1); });
defineMethod("readInt8", function (this: Uint8Array, offset?: number): number { return signed(readUIntLE(this, toOffset(offset), 1), 1); });
defineMethod("readUInt16LE", function (this: Uint8Array, offset?: number): number { return readUIntLE(this, toOffset(offset), 2); });
defineMethod("readUInt16BE", function (this: Uint8Array, offset?: number): number { return readUIntBE(this, toOffset(offset), 2); });
defineMethod("readInt16LE", function (this: Uint8Array, offset?: number): number { return signed(readUIntLE(this, toOffset(offset), 2), 2); });
defineMethod("readInt16BE", function (this: Uint8Array, offset?: number): number { return signed(readUIntBE(this, toOffset(offset), 2), 2); });
defineMethod("readUInt32LE", function (this: Uint8Array, offset?: number): number { return readUIntLE(this, toOffset(offset), 4); });
defineMethod("readUInt32BE", function (this: Uint8Array, offset?: number): number { return readUIntBE(this, toOffset(offset), 4); });
defineMethod("readInt32LE", function (this: Uint8Array, offset?: number): number { return signed(readUIntLE(this, toOffset(offset), 4), 4); });
defineMethod("readInt32BE", function (this: Uint8Array, offset?: number): number { return signed(readUIntBE(this, toOffset(offset), 4), 4); });
defineMethod("readUIntLE", function (this: Uint8Array, offset: number, byteLength: number): number { checkByteLength(byteLength); return readUIntLE(this, offset, byteLength); });
defineMethod("readUIntBE", function (this: Uint8Array, offset: number, byteLength: number): number { checkByteLength(byteLength); return readUIntBE(this, offset, byteLength); });
defineMethod("readIntLE", function (this: Uint8Array, offset: number, byteLength: number): number { checkByteLength(byteLength); return signed(readUIntLE(this, offset, byteLength), byteLength); });
defineMethod("readIntBE", function (this: Uint8Array, offset: number, byteLength: number): number { checkByteLength(byteLength); return signed(readUIntBE(this, offset, byteLength), byteLength); });
defineMethod("writeUInt8", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntLE(this, value, toOffset(offset), 1, 0, 255); });
defineMethod("writeInt8", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntLE(this, value, toOffset(offset), 1, -128, 127); });
defineMethod("writeUInt16LE", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntLE(this, value, toOffset(offset), 2, 0, 65535); });
defineMethod("writeUInt16BE", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntBE(this, value, toOffset(offset), 2, 0, 65535); });
defineMethod("writeInt16LE", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntLE(this, value, toOffset(offset), 2, -32768, 32767); });
defineMethod("writeInt16BE", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntBE(this, value, toOffset(offset), 2, -32768, 32767); });
defineMethod("writeUInt32LE", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntLE(this, value, toOffset(offset), 4, 0, 4294967295); });
defineMethod("writeUInt32BE", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntBE(this, value, toOffset(offset), 4, 0, 4294967295); });
defineMethod("writeInt32LE", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntLE(this, value, toOffset(offset), 4, -2147483648, 2147483647); });
defineMethod("writeInt32BE", function (this: Uint8Array, value: number, offset?: number): number { return writeUIntBE(this, value, toOffset(offset), 4, -2147483648, 2147483647); });
defineMethod("writeUIntLE", function (this: Uint8Array, value: number, offset: number, byteLength: number): number { checkByteLength(byteLength); return writeUIntLE(this, value, offset, byteLength, 0, Math.pow(2, byteLength * 8) - 1); });
defineMethod("writeUIntBE", function (this: Uint8Array, value: number, offset: number, byteLength: number): number { checkByteLength(byteLength); return writeUIntBE(this, value, offset, byteLength, 0, Math.pow(2, byteLength * 8) - 1); });
defineMethod("writeIntLE", function (this: Uint8Array, value: number, offset: number, byteLength: number): number { checkByteLength(byteLength); const lim = Math.pow(2, byteLength * 8 - 1); return writeUIntLE(this, value, offset, byteLength, -lim, lim - 1); });
defineMethod("writeIntBE", function (this: Uint8Array, value: number, offset: number, byteLength: number): number { checkByteLength(byteLength); const lim = Math.pow(2, byteLength * 8 - 1); return writeUIntBE(this, value, offset, byteLength, -lim, lim - 1); });
for (const [a, b] of [["readUint8", "readUInt8"], ["readUint16LE", "readUInt16LE"], ["readUint16BE", "readUInt16BE"], ["readUint32LE", "readUInt32LE"], ["readUint32BE", "readUInt32BE"], ["readUintLE", "readUIntLE"], ["readUintBE", "readUIntBE"],
  ["writeUint8", "writeUInt8"], ["writeUint16LE", "writeUInt16LE"], ["writeUint16BE", "writeUInt16BE"], ["writeUint32LE", "writeUInt32LE"], ["writeUint32BE", "writeUInt32BE"], ["writeUintLE", "writeUIntLE"], ["writeUintBE", "writeUIntBE"]]) proto[a] = proto[b];
// floats, through a shared view (the host is little-endian)
const f64 = new Float64Array(1);
const f64bytes = new Uint8Array(f64.buffer);
const f32 = new Float32Array(1);
const f32bytes = new Uint8Array(f32.buffer);
function readFloat(buf: Uint8Array, offset: number, size: number, le: boolean): number {
  checkBounds(buf, offset, size);
  const bytes = size === 8 ? f64bytes : f32bytes;
  for (let i = 0; i < size; i++) bytes[le ? i : size - 1 - i] = buf[offset + i];
  return size === 8 ? f64[0] : f32[0];
}
function writeFloat(buf: Uint8Array, value: number, offset: number, size: number, le: boolean): number {
  if (typeof value !== "number") throw invalidArgType("value", "of type number", value);
  checkBounds(buf, offset, size);
  const bytes = size === 8 ? f64bytes : f32bytes;
  if (size === 8) f64[0] = value; else f32[0] = value;
  for (let i = 0; i < size; i++) buf[offset + i] = bytes[le ? i : size - 1 - i];
  return offset + size;
}
defineMethod("readFloatLE", function (this: Uint8Array, offset?: number): number { return readFloat(this, toOffset(offset), 4, true); });
defineMethod("readFloatBE", function (this: Uint8Array, offset?: number): number { return readFloat(this, toOffset(offset), 4, false); });
defineMethod("readDoubleLE", function (this: Uint8Array, offset?: number): number { return readFloat(this, toOffset(offset), 8, true); });
defineMethod("readDoubleBE", function (this: Uint8Array, offset?: number): number { return readFloat(this, toOffset(offset), 8, false); });
defineMethod("writeFloatLE", function (this: Uint8Array, value: number, offset?: number): number { return writeFloat(this, value, toOffset(offset), 4, true); });
defineMethod("writeFloatBE", function (this: Uint8Array, value: number, offset?: number): number { return writeFloat(this, value, toOffset(offset), 4, false); });
defineMethod("writeDoubleLE", function (this: Uint8Array, value: number, offset?: number): number { return writeFloat(this, value, toOffset(offset), 8, true); });
defineMethod("writeDoubleBE", function (this: Uint8Array, value: number, offset?: number): number { return writeFloat(this, value, toOffset(offset), 8, false); });
function swap(buf: Uint8Array, n: number): Uint8Array {
  if (buf.length % n !== 0) throw codedRangeError("ERR_INVALID_BUFFER_SIZE", "Buffer size must be a multiple of " + (n * 8) + "-bits");
  for (let i = 0; i < buf.length; i += n) {
    for (let a = i, b = i + n - 1; a < b; a++, b--) { const t = buf[a]; buf[a] = buf[b]; buf[b] = t; }
  }
  return buf;
}
defineMethod("swap16", function (this: Uint8Array): Uint8Array { return swap(this, 2); });
defineMethod("swap32", function (this: Uint8Array): Uint8Array { return swap(this, 4); });
defineMethod("swap64", function (this: Uint8Array): Uint8Array { return swap(this, 8); });

// ---- the constructor object ----
function checkSize(size: unknown): number {
  if (typeof size !== "number") throw invalidArgType("size", "of type number", size);
  if (size < 0 || size > 9007199254740991 || size !== size) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"size\" is out of range. It must be >= 0 && <= 9007199254740991. Received " + addNumericalSeparator(String(size)));
  return Math.floor(size);
}
function fromValue(value: unknown, byteOffsetOrEncoding?: number | string, length?: number): Buffer {
  if (typeof value === "string") return adopt(encodeString(value, encodingOf(typeof byteOffsetOrEncoding === "string" ? byteOffsetOrEncoding : undefined)));
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
    const off = typeof byteOffsetOrEncoding === "number" ? byteOffsetOrEncoding : 0;
    if (off < 0 || off > value.byteLength) throw codedRangeError("ERR_BUFFER_OUT_OF_BOUNDS", "\"offset\" is outside of buffer bounds");
    const len = length === undefined ? value.byteLength - off : length;
    if (len < 0 || off + len > value.byteLength) throw codedRangeError("ERR_BUFFER_OUT_OF_BOUNDS", "\"length\" is outside of buffer bounds");
    return adopt(new Uint8Array(value, off, len));
  }
  if (value instanceof Uint8Array) { const out = new Uint8Array(value.length); out.set(value); return adopt(out); }
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    const src = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const out = new Uint8Array(src.length); out.set(src); return adopt(out);
  }
  if (Array.isArray(value)) {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = (value[i] as number) & 255;
    return adopt(out);
  }
  if (typeof value === "object" && value !== null) {
    const o = value as { type?: unknown; data?: unknown; length?: unknown; valueOf?: () => unknown };
    if (o.type === "Buffer" && Array.isArray(o.data)) return fromValue(o.data);
    if (typeof o.length === "number") {
      const out = new Uint8Array(o.length as number);
      const arr = value as { [index: number]: number };
      for (let i = 0; i < out.length; i++) out[i] = (arr[i] | 0) & 255;
      return adopt(out);
    }
    if (typeof o.valueOf === "function") { const prim = o.valueOf(); if (prim !== value && (typeof prim === "string" || typeof prim === "object")) return fromValue(prim, byteOffsetOrEncoding, length); }
  }
  throw invalidArgType("first argument", "of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object", value);
}
export const Buffer: BufferConstructor = {
  from: fromValue as BufferConstructor["from"],
  alloc(size: number, fill?: string | number | Uint8Array, encoding?: string): Buffer {
    const b = adopt(new Uint8Array(checkSize(size)));
    if (fill !== undefined && fill !== 0 && b.length > 0) b.fill(fill, 0, b.length, encoding);
    return b;
  },
  allocUnsafe(size: number): Buffer { return adopt(new Uint8Array(checkSize(size))); },
  allocUnsafeSlow(size: number): Buffer { return adopt(new Uint8Array(checkSize(size))); },
  byteLength(value: string | ArrayBufferView | ArrayBuffer, encoding?: string): number {
    if (typeof value === "string") return byteLengthOf(value, encodingOf(encoding));
    if (ArrayBuffer.isView(value)) return (value as ArrayBufferView).byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if ((value as unknown) instanceof SharedArrayBuffer) return (value as unknown as SharedArrayBuffer).byteLength;
    throw invalidArgType("string", "of type string or an instance of Buffer or ArrayBuffer", value);
  },
  isBuffer(value: unknown): value is Buffer { return isBufferValue(value); },
  isEncoding(encoding: string): boolean { return typeof encoding === "string" && encoding.length > 0 && normalizeEncoding(encoding) !== undefined; },
  concat(list: Uint8Array[], totalLength?: number): Buffer {
    if (!Array.isArray(list)) throw invalidArgType("list", "an instance of Array", list);
    let total = totalLength === undefined ? 0 : checkSize(totalLength);
    if (totalLength === undefined) for (const b of list) total += b.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const b of list) {
      if (!(b instanceof Uint8Array)) throw invalidArgType("list[0]", "an instance of Buffer or Uint8Array", b);
      const n = Math.min(b.length, total - pos);
      for (let i = 0; i < n; i++) out[pos + i] = b[i];
      pos += n;
      if (pos >= total) break;
    }
    return adopt(out);
  },
  compare(a: Uint8Array, b: Uint8Array): number {
    if (!(a instanceof Uint8Array)) throw invalidArgType("buf1", "an instance of Buffer or Uint8Array", a);
    if (!(b instanceof Uint8Array)) throw invalidArgType("buf2", "an instance of Buffer or Uint8Array", b);
    return compareBytes(a, 0, a.length, b, 0, b.length);
  },
  copyBytesFrom(view: ArrayBufferView, offset?: number, length?: number): Buffer {
    const src = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const unit = view.byteLength / ((view as unknown as { length: number }).length || 1);
    const start = (offset === undefined ? 0 : offset) * unit;
    const end = length === undefined ? src.length : Math.min(src.length, start + length * unit);
    const out = new Uint8Array(Math.max(0, end - start));
    for (let i = 0; i < out.length; i++) out[i] = src[start + i];
    return adopt(out);
  },
  poolSize: 8192,
  prototype: proto as unknown as Buffer,
  [Symbol.hasInstance](value: unknown): boolean { return isBufferValue(value); },
};
export const kMaxLength = 4294967295;
export const kStringMaxLength = 536870888;
export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength };
export const INSPECT_MAX_BYTES = 50;
export function atob(data: string): string { return decodeBytes(encodeString(String(data), "base64"), "latin1", 0, encodeString(String(data), "base64").length); }
export function btoa(data: string): string {
  const s = String(data);
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) throw codedTypeError("ERR_INVALID_CHAR", "Invalid character");
  const bytes = encodeString(s, "latin1");
  return decodeBytes(bytes, "base64", 0, bytes.length);
}
export function isUtf8(input: Uint8Array): boolean {
  let i = 0;
  while (i < input.length) {
    const b = input[i];
    let n = 0, min = 0;
    if (b < 0x80) { i++; continue; }
    else if ((b & 0xE0) === 0xC0) { n = 1; min = 0x80; }
    else if ((b & 0xF0) === 0xE0) { n = 2; min = 0x800; }
    else if ((b & 0xF8) === 0xF0) { n = 3; min = 0x10000; }
    else return false;
    if (i + n >= input.length) return false;
    let cp = b & (0x3F >> n);
    for (let k = 1; k <= n; k++) { const c = input[i + k]; if ((c & 0xC0) !== 0x80) return false; cp = (cp << 6) | (c & 0x3F); }
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
    i += n + 1;
  }
  return true;
}
export function isAscii(input: Uint8Array): boolean { for (let i = 0; i < input.length; i++) if (input[i] > 127) return false; return true; }
const bufferModule = { Buffer, kMaxLength, kStringMaxLength, constants, INSPECT_MAX_BYTES, atob, btoa, isUtf8, isAscii };
export default bufferModule;
