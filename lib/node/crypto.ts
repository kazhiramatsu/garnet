// node:crypto (docs/node_compat_design.md): digests (md5, sha1, sha256 and
// sha512, computed by the host in C), HMAC and PBKDF2 over them, random bytes,
// integers and UUIDs, and a constant-time comparison. Ciphers, key objects,
// signatures and the subtle API do not exist here: a program that names them
// stops with a TypeError, never a wrong result.
import { Buffer, fromView } from "./buffer";
import { host } from "./host";
import { codedError, codedRangeError, codedTypeError, invalidArgType, outOfRange, validateString } from "./errors";

export type BinaryLike = string | ArrayBufferView;
export type BinaryToTextEncoding = "base64" | "base64url" | "hex" | "binary" | "latin1";

const DIGESTS: { [name: string]: { size: number; block: number } } = {
  md5: { size: 16, block: 64 },
  sha1: { size: 20, block: 64 },
  sha256: { size: 32, block: 64 },
  sha512: { size: 64, block: 128 },
};
/** The host's name of a digest, from Node's spellings ("SHA256", "sha-256", "RSA-SHA256"). */
function digestName(algorithm: string): string | undefined {
  let n = algorithm.toLowerCase();
  if (n.startsWith("rsa-")) n = n.slice(4);
  n = n.replace("-", "");
  return DIGESTS[n] !== undefined ? n : undefined;
}
function unsupportedDigest(): never {
  throw new Error("Digest method not supported");   // as Node: a plain Error without a code
}
function isView(value: unknown): value is ArrayBufferView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as ArrayBufferView;
  return typeof v.byteLength === "number" && typeof v.byteOffset === "number" &&
    (v.buffer instanceof ArrayBuffer || v.buffer instanceof SharedArrayBuffer);
}
/** The bytes of a string (by `encoding`, utf8 when none) or of a view. */
function toBytes(data: BinaryLike, encoding: string | undefined, name: string): Buffer {
  if (typeof data === "string") return Buffer.from(data, encoding === undefined || encoding === "buffer" ? "utf8" : encoding);
  if (isView(data)) return fromView(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  throw invalidArgType(name, "of type string or an instance of Buffer, TypedArray, or DataView", data);
}
function rawDigest(algorithm: string, data: Uint8Array): Buffer {
  const out = host.hash(algorithm, data);
  if (out === undefined) unsupportedDigest();
  return fromView(out);
}
function encodeOutput(bytes: Buffer, encoding: string | undefined): Buffer | string {
  if (encoding === undefined || encoding === "buffer") return bytes;
  return bytes.toString(encoding);
}

export class Hash {
  private chunks: Buffer[] = [];
  private finalized = false;
  constructor(private readonly algorithm: string) {}
  update(data: BinaryLike, inputEncoding?: string): this {
    if (this.finalized) throw codedError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    this.chunks.push(toBytes(data, inputEncoding, "data"));
    return this;
  }
  digest(): Buffer;
  digest(encoding: string): string;
  digest(encoding?: string): Buffer | string {
    if (this.finalized) throw codedError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    this.finalized = true;
    return encodeOutput(rawDigest(this.algorithm, Buffer.concat(this.chunks)), encoding);
  }
  /** A copy of the state so far; the copy may be updated and digested separately. */
  copy(): Hash {
    if (this.finalized) throw codedError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    const h = new Hash(this.algorithm);
    h.chunks = this.chunks.slice();
    return h;
  }
}

/** HMAC (RFC 2104): H((K ^ opad) || H((K ^ ipad) || message)) over the digest's block. */
function hmacPads(algorithm: string, key: Uint8Array): { ipad: Buffer; opad: Buffer } {
  const block = DIGESTS[algorithm].block;
  let k: Uint8Array = key;
  if (k.length > block) k = rawDigest(algorithm, k);
  const ipad = Buffer.alloc(block, 0x36);
  const opad = Buffer.alloc(block, 0x5c);
  for (let i = 0; i < k.length; i++) { ipad[i] ^= k[i]; opad[i] ^= k[i]; }
  return { ipad, opad };
}
function hmacDigest(algorithm: string, pads: { ipad: Buffer; opad: Buffer }, parts: Uint8Array[]): Buffer {
  const inner = rawDigest(algorithm, Buffer.concat([pads.ipad, ...parts]));
  return rawDigest(algorithm, Buffer.concat([pads.opad, inner]));
}

export class Hmac {
  private chunks: Buffer[] = [];
  private finalized = false;
  private readonly pads: { ipad: Buffer; opad: Buffer };
  constructor(private readonly algorithm: string, key: BinaryLike) {
    this.pads = hmacPads(algorithm, toBytes(key, undefined, "key"));
  }
  update(data: BinaryLike, inputEncoding?: string): this {
    if (this.finalized) throw codedError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    this.chunks.push(toBytes(data, inputEncoding, "data"));
    return this;
  }
  digest(): Buffer;
  digest(encoding: string): string;
  digest(encoding?: string): Buffer | string {
    if (this.finalized) throw codedError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    this.finalized = true;
    return encodeOutput(hmacDigest(this.algorithm, this.pads, this.chunks), encoding);
  }
}

export function createHash(algorithm: string, _options?: object): Hash {
  validateString(algorithm, "algorithm");
  const name = digestName(algorithm);
  if (name === undefined) unsupportedDigest();
  return new Hash(name);
}
export function createHmac(algorithm: string, key: BinaryLike, _options?: object): Hmac {
  validateString(algorithm, "algorithm");
  const name = digestName(algorithm);
  if (name === undefined) throw codedTypeError("ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${algorithm}`);
  if (typeof key !== "string" && !isView(key)) throw invalidArgType("key", "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey", key);
  return new Hmac(name, key);
}
/** One-shot digest: a hex string by default, bytes for "buffer". */
export function hash(algorithm: string, data: BinaryLike, outputEncoding: string = "hex"): string | Buffer {
  validateString(algorithm, "algorithm");
  const name = digestName(algorithm);
  if (name === undefined) unsupportedDigest();
  return encodeOutput(rawDigest(name, toBytes(data, undefined, "data")), outputEncoding);
}
export function getHashes(): string[] { return ["md5", "sha1", "sha256", "sha512"]; }

function validateSize(size: unknown, name: string): asserts size is number {
  if (typeof size !== "number") throw invalidArgType(name, "of type number", size);
  if (!Number.isInteger(size) || size < 0 || size > 2147483647) throw outOfRange(name, ">= 0 && <= 2147483647", size);
}
type BytesCallback = (err: Error | null, buf: Buffer) => void;
/** `size` random bytes; with a callback, delivered on a later turn. */
export function randomBytes(size: number): Buffer;
export function randomBytes(size: number, callback: BytesCallback): void;
export function randomBytes(size: number, callback?: BytesCallback): Buffer | void {
  validateSize(size, "size");
  const out = fromView(host.randomBytes(size));
  if (callback === undefined) return out;
  if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
  host.immediate(() => callback(null, out), undefined);
}
function viewBytes(view: ArrayBufferView): Uint8Array { return new Uint8Array(view.buffer, view.byteOffset, view.byteLength); }
export function randomFillSync<T extends ArrayBufferView>(buffer: T, offset: number = 0, size?: number): T {
  if (!isView(buffer)) throw invalidArgType("buf", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", buffer);
  const bytes = viewBytes(buffer);
  const elementSize = bytes.length === 0 ? 1 : bytes.length / ((buffer as unknown as { length?: number }).length ?? bytes.length);
  const start = offset * elementSize;
  const count = size === undefined ? bytes.length - start : size * elementSize;
  if (!Number.isInteger(start) || start < 0 || start > bytes.length) throw outOfRange("offset", `>= 0 && <= ${bytes.length / elementSize}`, offset);
  if (!Number.isInteger(count) || count < 0 || start + count > bytes.length) throw outOfRange("size", `>= 0 && <= ${(bytes.length - start) / elementSize}`, size);
  bytes.set(host.randomBytes(count), start);
  return buffer;
}
export function randomFill<T extends ArrayBufferView>(buffer: T, offsetOrCallback: number | ((err: Error | null, buf: T) => void), sizeOrCallback?: number | ((err: Error | null, buf: T) => void), callback?: (err: Error | null, buf: T) => void): void {
  let offset = 0;
  let size: number | undefined = undefined;
  let cb: ((err: Error | null, buf: T) => void) | undefined;
  if (typeof offsetOrCallback === "function") cb = offsetOrCallback;
  else {
    offset = offsetOrCallback;
    if (typeof sizeOrCallback === "function") cb = sizeOrCallback;
    else { size = sizeOrCallback; cb = callback; }
  }
  if (typeof cb !== "function") throw invalidArgType("callback", "of type function", cb);
  const done = cb;
  randomFillSync(buffer, offset, size);
  host.immediate(() => done(null, buffer), undefined);
}
const RANGE_LIMIT = 281474976710655; // 2^48 - 1
type IntCallback = (err: Error | null, n: number) => void;
/** A uniform integer in [min, max) (or [0, max)), by rejection sampling over 48 bits. */
export function randomInt(max: number): number;
export function randomInt(min: number, max: number): number;
export function randomInt(max: number, callback: IntCallback): void;
export function randomInt(min: number, max: number, callback: IntCallback): void;
export function randomInt(a: number, b?: number | IntCallback, c?: IntCallback): number | void {
  let min = 0, max: number, callback: IntCallback | undefined;
  if (typeof b === "function" || b === undefined) { max = a; callback = b as IntCallback | undefined; }
  else { min = a; max = b; callback = c; }
  if (!Number.isSafeInteger(min)) throw invalidArgType("min", "a safe integer", min);
  if (!Number.isSafeInteger(max)) throw invalidArgType("max", "a safe integer", max);
  if (max <= min) throw outOfRange("max", `greater than the value of "min" (${min})`, max);
  const range = max - min;
  if (range > RANGE_LIMIT) throw outOfRange("max - min", `<= ${RANGE_LIMIT}`, range);
  const limit = 281474976710656 - (281474976710656 % range);
  let x: number;
  do {
    const r = host.randomBytes(6);
    x = ((r[0] * 256 + r[1]) * 65536 + (r[2] * 256 + r[3])) * 65536 + (r[4] * 256 + r[5]);
  } while (x >= limit);
  const n = min + (x % range);
  if (callback === undefined) return n;
  if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
  const done = callback;
  host.immediate(() => done(null, n), undefined);
}
/** A version 4 UUID. */
export function randomUUID(_options?: { disableEntropyCache?: boolean }): string {
  const b = host.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = fromView(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Web Crypto's getRandomValues: fills an integer typed array (at most 65536 bytes). */
export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  if (!isView(array) || array instanceof Float32Array || array instanceof Float64Array || typeof (array as unknown as { getInt8?: unknown }).getInt8 === "function") {
    throw codedTypeError("ERR_INVALID_ARG_TYPE", "The \"typedArray\" argument must be an integer-type TypedArray");
  }
  if (array.byteLength > 65536) {
    const e = new Error(`The ArrayBufferView's byte length (${array.byteLength}) exceeds the number of bytes of entropy available via this API (65536)`);
    e.name = "QuotaExceededError";
    throw e;
  }
  viewBytes(array).set(host.randomBytes(array.byteLength));
  return array;
}
/** Equal byte strings, compared in time that depends only on the length. */
export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (!isView(a)) throw invalidArgType("buf1", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", a);
  if (!isView(b)) throw invalidArgType("buf2", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", b);
  if (a.byteLength !== b.byteLength) throw codedRangeError("ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "Input buffers must have the same byte length");
  const x = viewBytes(a), y = viewBytes(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** PBKDF2 (RFC 8018) with HMAC over `digest`. */
export function pbkdf2Sync(password: BinaryLike, salt: BinaryLike, iterations: number, keylen: number, digest: string): Buffer {
  const p = toBytes(password, undefined, "password");
  const s = toBytes(salt, undefined, "salt");
  if (typeof iterations !== "number") throw invalidArgType("iterations", "of type number", iterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2147483647) throw outOfRange("iterations", ">= 1 && <= 2147483647", iterations);
  validateSize(keylen, "keylen");
  validateString(digest, "digest");
  const name = digestName(digest);
  if (name === undefined) throw codedTypeError("ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${digest}`);
  const pads = hmacPads(name, p);
  const size = DIGESTS[name].size;
  const out = Buffer.alloc(keylen);
  const counter = Buffer.alloc(4);
  let offset = 0;
  for (let block = 1; offset < keylen; block++) {
    counter[0] = (block >>> 24) & 0xff; counter[1] = (block >>> 16) & 0xff; counter[2] = (block >>> 8) & 0xff; counter[3] = block & 0xff;
    let u = hmacDigest(name, pads, [s, counter]);
    const t = Buffer.from(u);
    for (let i = 1; i < iterations; i++) {
      u = hmacDigest(name, pads, [u]);
      for (let j = 0; j < size; j++) t[j] ^= u[j];
    }
    const n = Math.min(size, keylen - offset);
    out.set(t.subarray(0, n), offset);
    offset += n;
  }
  return out;
}
export function pbkdf2(password: BinaryLike, salt: BinaryLike, iterations: number, keylen: number, digest: string,
                       callback: (err: Error | null, derivedKey: Buffer) => void): void {
  if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
  const key = pbkdf2Sync(password, salt, iterations, keylen, digest);
  host.immediate(() => callback(null, key), undefined);
}

export const webcrypto = { getRandomValues, randomUUID };
export const constants = {};

const crypto = {
  createHash, createHmac, hash, getHashes, randomBytes, randomFillSync, randomFill, randomInt, randomUUID,
  getRandomValues, timingSafeEqual, pbkdf2Sync, pbkdf2, webcrypto, constants, Hash, Hmac,
};
export default crypto;
