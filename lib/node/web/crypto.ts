// Web Crypto (docs/web_crypto_design.md): the `crypto` global over node:crypto's primitives. The
// subtle API covers what server code uses without a key store: digests (SHA-1, SHA-256, SHA-384,
// SHA-512) and HMAC keys (raw and JWK `oct` import, sign, verify, export, generate); getRandomValues
// and randomUUID are node:crypto's. RSA, ECDSA and AES keys are not provided: a NotSupportedError
// names them. Under the V8 oracle the global is Node's own, whose errors these follow.
import { Buffer } from "../buffer";
import { createHash, createHmac, getRandomValues as randomValues, randomUUID as uuid, timingSafeEqual } from "../crypto";

/** Node's DOMException for the Web Crypto errors: an Error whose `name` is the error's. */
class WebCryptoError extends Error {
  constructor(message: string, name: string) { super(message); this.name = name; }
}
const notSupported = (message: string): never => { throw new WebCryptoError(message, "NotSupportedError"); };
const invalidAccess = (message: string): never => { throw new WebCryptoError(message, "InvalidAccessError"); };

const HASHES: Record<string, { node: string; size: number; block: number }> = {
  "SHA-1": { node: "sha1", size: 20, block: 64 },
  "SHA-256": { node: "sha256", size: 32, block: 64 },
  "SHA-384": { node: "sha384", size: 48, block: 128 },
  "SHA-512": { node: "sha512", size: 64, block: 128 },
};
type AlgorithmLike = string | { name: string; hash?: string | { name: string }; length?: number };
function algorithmName(algorithm: AlgorithmLike): string {
  const name = typeof algorithm === "string" ? algorithm : algorithm === null || typeof algorithm !== "object" ? undefined : algorithm.name;
  if (typeof name !== "string") throw new TypeError("Failed to read the 'name' property from 'Algorithm': Required member is undefined.");
  return name.toUpperCase();
}
function hashName(hash: string | { name: string } | undefined): string {
  if (hash === undefined) throw new TypeError("Failed to read the 'hash' property from 'HmacImportParams': Required member is undefined.");
  const name = typeof hash === "string" ? hash : hash.name;
  const up = String(name).toUpperCase();
  if (HASHES[up] === undefined) notSupported("Unrecognized algorithm name");
  return up;
}
/** The bytes of a BufferSource (an ArrayBuffer or a view over one). */
function bytesOf(data: unknown, what: string): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const v = data as ArrayBufferView;
  if (typeof data === "object" && data !== null && typeof v.byteLength === "number" && typeof v.byteOffset === "number" && v.buffer instanceof ArrayBuffer) {
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  throw new TypeError(`The "${what}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`);
}
/** A fresh ArrayBuffer holding exactly these bytes (the result of a digest or a signature). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer { return new Uint8Array(bytes).buffer; }

export type KeyUsage = "sign" | "verify" | "encrypt" | "decrypt" | "deriveKey" | "deriveBits" | "wrapKey" | "unwrapKey";
export interface HmacKeyAlgorithm { name: "HMAC"; hash: { name: string }; length: number }

export class CryptoKey {
  readonly type: "secret" | "public" | "private";
  readonly extractable: boolean;
  readonly algorithm: HmacKeyAlgorithm;
  readonly usages: KeyUsage[];
  #bytes: Uint8Array;
  constructor(type: "secret", algorithm: HmacKeyAlgorithm, extractable: boolean, usages: KeyUsage[], bytes: Uint8Array) {
    this.type = type;
    this.algorithm = algorithm;
    this.extractable = extractable;
    this.usages = usages;
    this.#bytes = bytes;
  }
  /** The key material, for the subtle API of this module only. */
  static bytesOf(key: CryptoKey): Uint8Array { return key.#bytes; }
}

const HMAC_USAGES: KeyUsage[] = ["sign", "verify"];
function hmacUsages(keyUsages: unknown): KeyUsage[] {
  const usages = Array.from((keyUsages ?? []) as Iterable<KeyUsage>);
  for (const u of usages) {
    if (!HMAC_USAGES.includes(u)) throw new WebCryptoError("Unsupported key usage for an HMAC key", "SyntaxError");
  }
  return usages;
}
function hmacParams(algorithm: AlgorithmLike): { hash: string; length?: number } {
  const name = algorithmName(algorithm);
  if (name !== "HMAC") notSupported(`Unrecognized algorithm name: ${typeof algorithm === "string" ? algorithm : algorithm.name} (only HMAC keys are provided)`);
  const a: { hash?: string | { name: string }; length?: number } = typeof algorithm === "string" ? {} : algorithm;
  return { hash: hashName(a.hash), length: a.length };
}
function hmacKey(bytes: Uint8Array, hash: string, extractable: boolean, usages: KeyUsage[], length?: number): CryptoKey {
  if (bytes.length === 0) throw new WebCryptoError("Zero-length key is not supported", "DataError");
  if (length !== undefined && length !== bytes.length * 8) throw new WebCryptoError("Invalid key length", "DataError");
  return new CryptoKey("secret", { name: "HMAC", hash: { name: hash }, length: bytes.length * 8 }, extractable, usages, bytes);
}
const JWK_ALG: Record<string, string> = { "SHA-1": "HS1", "SHA-256": "HS256", "SHA-384": "HS384", "SHA-512": "HS512" };
function hmacDigest(key: CryptoKey, data: Uint8Array): Uint8Array {
  const h = HASHES[key.algorithm.hash.name];
  const mac = createHmac(h.node, CryptoKey.bytesOf(key)).update(data).digest();
  return new Uint8Array(mac.buffer, mac.byteOffset, mac.byteLength);
}
function checkHmacUse(algorithm: AlgorithmLike, key: CryptoKey, usage: KeyUsage): void {
  if (!(key instanceof CryptoKey)) throw new TypeError("Failed to execute operation: parameter 2 is not of type 'CryptoKey'.");
  if (algorithmName(algorithm) !== "HMAC" || key.algorithm.name !== "HMAC") invalidAccess("The key's algorithm does not match the operation");
  if (!key.usages.includes(usage)) invalidAccess(`Unable to use this key to ${usage}`);
}

export class SubtleCrypto {
  async digest(algorithm: AlgorithmLike, data: unknown): Promise<ArrayBuffer> {
    const name = hashName(typeof algorithm === "string" ? algorithm : algorithm.name);
    const bytes = bytesOf(data, "data");
    const out = createHash(HASHES[name].node).update(bytes).digest();
    return toArrayBuffer(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
  }
  async importKey(format: string, keyData: unknown, algorithm: AlgorithmLike, extractable: boolean, keyUsages: unknown): Promise<CryptoKey> {
    const { hash, length } = hmacParams(algorithm);
    const usages = hmacUsages(keyUsages);
    if (format === "raw") return hmacKey(new Uint8Array(bytesOf(keyData, "keyData")), hash, extractable, usages, length);
    if (format === "jwk") {
      const jwk = keyData as { kty?: string; k?: string; alg?: string; use?: string; key_ops?: string[]; ext?: boolean };
      if (typeof jwk !== "object" || jwk === null) throw new TypeError("The 'keyData' argument must be an object for the 'jwk' format.");
      if (jwk.kty !== "oct") throw new WebCryptoError("Invalid JWK \"kty\" Parameter", "DataError");
      if (typeof jwk.k !== "string") throw new WebCryptoError("Invalid JWK \"k\" Parameter", "DataError");
      if (jwk.alg !== undefined && jwk.alg !== JWK_ALG[hash]) throw new WebCryptoError("JWK \"alg\" does not match the requested algorithm", "DataError");
      if (jwk.ext === false && extractable) throw new WebCryptoError("JWK \"ext\" Parameter and extractable mismatch", "DataError");
      const bytes = Buffer.from(jwk.k, "base64url");
      return hmacKey(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), hash, extractable, usages, length);
    }
    if (format === "pkcs8" || format === "spki") notSupported(`${format} keys are not provided (only HMAC keys)`);
    throw new TypeError(`Invalid keyFormat argument: ${format}`);
  }
  async exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer | Record<string, unknown>> {
    if (!(key instanceof CryptoKey)) throw new TypeError("parameter 2 is not of type 'CryptoKey'.");
    if (!key.extractable) throw new WebCryptoError("key is not extractable", "InvalidAccessException");   // Node's name here (not InvalidAccessError)
    const bytes = CryptoKey.bytesOf(key);
    if (format === "raw") return toArrayBuffer(bytes);
    if (format === "jwk") {
      return { key_ops: key.usages.slice(), ext: key.extractable, kty: "oct", k: Buffer.from(bytes).toString("base64url"), alg: JWK_ALG[key.algorithm.hash.name] };
    }
    if (format === "pkcs8" || format === "spki") notSupported(`${format} export is not provided (only HMAC keys)`);
    throw new TypeError(`Invalid keyFormat argument: ${format}`);
  }
  async generateKey(algorithm: AlgorithmLike, extractable: boolean, keyUsages: unknown): Promise<CryptoKey> {
    const { hash, length } = hmacParams(algorithm);
    const usages = hmacUsages(keyUsages);
    const bits = length === undefined ? HASHES[hash].block * 8 : length;
    if (bits === 0 || bits % 8 !== 0) throw new WebCryptoError("Invalid key length", "OperationError");
    const bytes = new Uint8Array(bits / 8);
    randomValues(bytes);
    return hmacKey(bytes, hash, extractable, usages);
  }
  async sign(algorithm: AlgorithmLike, key: CryptoKey, data: unknown): Promise<ArrayBuffer> {
    checkHmacUse(algorithm, key, "sign");
    return toArrayBuffer(hmacDigest(key, bytesOf(data, "data")));
  }
  async verify(algorithm: AlgorithmLike, key: CryptoKey, signature: unknown, data: unknown): Promise<boolean> {
    checkHmacUse(algorithm, key, "verify");
    const sig = bytesOf(signature, "signature");
    const mac = hmacDigest(key, bytesOf(data, "data"));
    return sig.byteLength === mac.byteLength && timingSafeEqual(sig, mac);
  }
  async encrypt(algorithm: AlgorithmLike, _key: CryptoKey, _data: unknown): Promise<ArrayBuffer> { return notSupported(`${algorithmName(algorithm)}: encryption is not provided`); }
  async decrypt(algorithm: AlgorithmLike, _key: CryptoKey, _data: unknown): Promise<ArrayBuffer> { return notSupported(`${algorithmName(algorithm)}: decryption is not provided`); }
  async deriveBits(algorithm: AlgorithmLike, _key: CryptoKey, _length: number): Promise<ArrayBuffer> { return notSupported(`${algorithmName(algorithm)}: key derivation is not provided`); }
  async deriveKey(algorithm: AlgorithmLike, _key: CryptoKey, _derived: AlgorithmLike, _extractable: boolean, _usages: unknown): Promise<CryptoKey> { return notSupported(`${algorithmName(algorithm)}: key derivation is not provided`); }
  async wrapKey(format: string, _key: CryptoKey, _wrapping: CryptoKey, algorithm: AlgorithmLike): Promise<ArrayBuffer> { return notSupported(`${algorithmName(algorithm)}: key wrapping (${format}) is not provided`); }
  async unwrapKey(format: string, _wrapped: unknown, _key: CryptoKey, algorithm: AlgorithmLike): Promise<CryptoKey> { return notSupported(`${algorithmName(algorithm)}: key unwrapping (${format}) is not provided`); }
}

/** An integer typed array (not a float view, not a DataView): the only arrays getRandomValues fills. */
function isIntegerTypedArray(array: unknown): boolean {
  return array instanceof Int8Array || array instanceof Uint8Array || array instanceof Uint8ClampedArray || array instanceof Int16Array ||
    array instanceof Uint16Array || array instanceof Int32Array || array instanceof Uint32Array;
}
export class Crypto {
  readonly subtle: SubtleCrypto = new SubtleCrypto();
  getRandomValues<T extends ArrayBufferView>(array: T): T {
    if (!isIntegerTypedArray(array)) throw new WebCryptoError("The data argument must be an integer-type TypedArray", "TypeMismatchError");
    return randomValues(array);
  }
  randomUUID(): string { return uuid(); }
}
export const crypto = new Crypto();
