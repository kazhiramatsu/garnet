// Uint8Array to and from base64 and hex (a program that names one of the methods compiles this): the specification's steps.

const taProto: any = Object.getPrototypeOf(Uint8Array.prototype);
const tagGetter: any = Object.getOwnPropertyDescriptor(taProto, Symbol.toStringTag)!.get;
const validateLive: any = taProto.fill;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function validate(ta: any): void {
  if (tagGetter.call(ta) !== "Uint8Array") throw new TypeError("The receiver is not a Uint8Array");
}
// a detached or out-of-bounds view is a TypeError: `fill` validates it, an empty range changes nothing
function validateInBounds(ta: any): void { validateLive.call(ta, 0, 0, 0); }
function optionsOf(options: any): any {
  if (options === undefined) return Object.create(null);
  if ((typeof options === "object" && options !== null) || typeof options === "function") return options;
  throw new TypeError("The options argument is not an object");
}
function alphabetOf(opts: any): string {
  const a = opts.alphabet;
  if (a === undefined) return "base64";
  if (a !== "base64" && a !== "base64url") throw new TypeError("Unknown alphabet");
  return a;
}
function lastChunkOf(opts: any): string {
  const h = opts.lastChunkHandling;
  if (h === undefined) return "loose";
  if (h !== "loose" && h !== "strict" && h !== "stop-before-partial") throw new TypeError("Unknown lastChunkHandling");
  return h;
}
function skipSpace(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d) break;
    i++;
  }
  return i;
}
function sextet(c: number): number {
  if (c >= 65 && c <= 90) return c - 65;
  if (c >= 97 && c <= 122) return c - 71;
  if (c >= 48 && c <= 57) return c + 4;
  return c === 43 ? 62 : 63;
}
// The chunk's values (two, three or four of them) as bytes: false when the extra bits of a short chunk are not zero.
function decodeChunk(chunk: number[], bytes: number[], throwOnExtraBits: boolean): boolean {
  const n = chunk.length;
  const a = chunk[0], b = chunk[1], c = n > 2 ? chunk[2] : 0, d = n > 3 ? chunk[3] : 0;
  const triple = (a << 18) | (b << 12) | (c << 6) | d;
  const b0 = (triple >> 16) & 255, b1 = (triple >> 8) & 255, b2 = triple & 255;
  if (n === 2) {
    if (throwOnExtraBits && b1 !== 0) return false;
    bytes.push(b0);
  } else if (n === 3) {
    if (throwOnExtraBits && b2 !== 0) return false;
    bytes.push(b0, b1);
  } else bytes.push(b0, b1, b2);
  return true;
}
interface Decoded { read: number; bytes: number[]; error: boolean }
function fromBase64(s: string, alphabet: string, lastChunk: string, maxLength: number): Decoded {
  const bytes: number[] = [];
  if (maxLength === 0) return { read: 0, bytes, error: false };
  let read = 0, index = 0;
  let chunk: number[] = [];
  const length = s.length;
  const fail = (): Decoded => ({ read, bytes, error: true });
  for (;;) {
    index = skipSpace(s, index);
    if (index === length) {
      if (chunk.length > 0) {
        if (lastChunk === "stop-before-partial") return { read, bytes, error: false };
        if (lastChunk === "loose") {
          if (chunk.length === 1) return fail();
          decodeChunk(chunk, bytes, false);
        } else return fail();
      }
      return { read: length, bytes, error: false };
    }
    let c = s.charCodeAt(index);
    index++;
    if (c === 61) {
      if (chunk.length < 2) return fail();
      index = skipSpace(s, index);
      if (chunk.length === 2) {
        if (index === length) {
          if (lastChunk === "stop-before-partial") return { read, bytes, error: false };
          return fail();
        }
        if (s.charCodeAt(index) !== 61) return fail();
        index = skipSpace(s, index + 1);
      }
      if (index < length) return fail();
      if (!decodeChunk(chunk, bytes, lastChunk === "strict")) return fail();
      return { read: length, bytes, error: false };
    }
    if (alphabet === "base64url") {
      if (c === 43 || c === 47) return fail();
      if (c === 45) c = 43;
      else if (c === 95) c = 47;
    }
    const known = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
    if (!known) return fail();
    const remaining = maxLength - bytes.length;
    if ((remaining === 1 && chunk.length === 2) || (remaining === 2 && chunk.length === 3)) return { read, bytes, error: false };
    chunk.push(sextet(c));
    if (chunk.length === 4) {
      decodeChunk(chunk, bytes, false);
      chunk = [];
      read = index;
      if (bytes.length === maxLength) return { read, bytes, error: false };
    }
  }
}
function hexit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}
function fromHex(s: string, maxLength: number): Decoded {
  const bytes: number[] = [];
  let read = 0;
  if (s.length % 2 !== 0) return { read, bytes, error: true };
  while (read < s.length && bytes.length < maxLength) {
    const hi = hexit(s.charCodeAt(read)), lo = hexit(s.charCodeAt(read + 1));
    if (hi < 0 || lo < 0) return { read, bytes, error: true };
    read += 2;
    bytes.push(hi * 16 + lo);
  }
  return { read, bytes, error: false };
}
const statics: any = {
  fromBase64(string: any, options: any = undefined): any {
    if (typeof string !== "string") throw new TypeError("The input is not a string");
    const opts = optionsOf(options);
    const alphabet = alphabetOf(opts);
    const lastChunk = lastChunkOf(opts);
    const r = fromBase64(string, alphabet, lastChunk, 9007199254740991);
    if (r.error) throw new SyntaxError("The string is not valid base64");
    return new Uint8Array(r.bytes);
  },
  fromHex(string: any): any {
    if (typeof string !== "string") throw new TypeError("The input is not a string");
    const r = fromHex(string, 9007199254740991);
    if (r.error) throw new SyntaxError("The string is not valid hex");
    return new Uint8Array(r.bytes);
  },
};
const methods: any = {
  toBase64(this: any, options: any = undefined): string {
    validate(this);
    const opts = optionsOf(options);
    const table = alphabetOf(opts) === "base64" ? BASE64 : BASE64URL;
    const omitPadding = !!opts.omitPadding;
    validateInBounds(this);
    const n = this.length;
    let out = "";
    let i = 0;
    for (; i + 2 < n; i += 3) {
      const t = (this[i] << 16) | (this[i + 1] << 8) | this[i + 2];
      out += table[(t >> 18) & 63] + table[(t >> 12) & 63] + table[(t >> 6) & 63] + table[t & 63];
    }
    if (n - i === 1) {
      const t = this[i] << 16;
      out += table[(t >> 18) & 63] + table[(t >> 12) & 63];
      if (!omitPadding) out += "==";
    } else if (n - i === 2) {
      const t = (this[i] << 16) | (this[i + 1] << 8);
      out += table[(t >> 18) & 63] + table[(t >> 12) & 63] + table[(t >> 6) & 63];
      if (!omitPadding) out += "=";
    }
    return out;
  },
  toHex(this: any): string {
    validate(this);
    validateInBounds(this);
    let out = "";
    for (let i = 0; i < this.length; i++) {
      const b = this[i];
      out += (b < 16 ? "0" : "") + b.toString(16);
    }
    return out;
  },
  setFromBase64(this: any, string: any, options: any = undefined): any {
    validate(this);
    if (typeof string !== "string") throw new TypeError("The input is not a string");
    const opts = optionsOf(options);
    const alphabet = alphabetOf(opts);
    const lastChunk = lastChunkOf(opts);
    validateInBounds(this);
    const r = fromBase64(string, alphabet, lastChunk, this.length);
    for (let i = 0; i < r.bytes.length; i++) this[i] = r.bytes[i];
    if (r.error) throw new SyntaxError("The string is not valid base64");
    return { read: r.read, written: r.bytes.length };
  },
  setFromHex(this: any, string: any): any {
    validate(this);
    if (typeof string !== "string") throw new TypeError("The input is not a string");
    validateInBounds(this);
    const r = fromHex(string, this.length);
    for (let i = 0; i < r.bytes.length; i++) this[i] = r.bytes[i];
    if (r.error) throw new SyntaxError("The string is not valid hex");
    return { read: r.read, written: r.bytes.length };
  },
};
for (const [name, length] of [["fromBase64", 1], ["fromHex", 1]] as [string, number][]) {
  Object.defineProperty(statics[name], "length", { value: length, configurable: true });
  Object.defineProperty(Uint8Array, name, { value: statics[name], writable: true, enumerable: false, configurable: true });
}
for (const [name, length] of [["toBase64", 0], ["toHex", 0], ["setFromBase64", 1], ["setFromHex", 1]] as [string, number][]) {
  Object.defineProperty(methods[name], "length", { value: length, configurable: true });
  Object.defineProperty(Uint8Array.prototype, name, { value: methods[name], writable: true, enumerable: false, configurable: true });
}
