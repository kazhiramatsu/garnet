# Web Crypto (`crypto`, `crypto.subtle`)

Session 358. hono's middleware survey (docs/real_projects.md "hono: the middleware survey")
found the `crypto` global missing behind nine of its drivers: basic-auth and bearer-auth
(`timingSafeEqual` hashes both sides with `crypto.subtle.digest`), signed cookies, jwt and
jwk (HMAC keys through `importKey` / `sign` / `verify`), etag (SHA-1 of the body), request-id
(`randomUUID`), secure-headers (a nonce from `getRandomValues`) and the crypto utils. This
document is the global's scope and how it is built.

## Scope

`lib/node/web/crypto.ts` is a TypeScript module compiled with the program, installed as the
globals `crypto`, `Crypto`, `SubtleCrypto` and `CryptoKey` by the Node prelude when the program
names one of them (`NODE_PRELUDE_PARTS`, docs/node_compat_design.md), over node:crypto's
primitives (`lib/node/crypto.ts`: the digests the host computes in C, HMAC over them, random
bytes). Under the V8 oracle the global is Node's own, whose results and error names these follow.

| member | provided |
|---|---|
| `crypto.getRandomValues(view)` | integer typed arrays up to 65536 bytes; a float view or a DataView is a `TypeMismatchError`, a larger view a `QuotaExceededError` |
| `crypto.randomUUID()` | a version-4 UUID |
| `subtle.digest(alg, data)` | SHA-1, SHA-256, SHA-384 (added to the host for it), SHA-512; `alg` a name or `{ name }`, case-insensitive; data an ArrayBuffer or a view; another name is a `NotSupportedError` |
| `subtle.importKey(format, data, alg, extractable, usages)` | HMAC keys: `raw` bytes or a JWK with `kty: "oct"` (its `alg` must agree with the hash, its `ext` with `extractable`); usages `sign` / `verify` only (a `SyntaxError` otherwise); a zero-length key a `DataError`; `pkcs8` / `spki` and every other algorithm (RSA, ECDSA, AES) a `NotSupportedError` |
| `subtle.sign` / `subtle.verify` | HMAC with the key's hash; the key's usages are checked (`InvalidAccessError`); verify compares in constant time and is false for a signature of another length |
| `subtle.exportKey` | `raw` (an ArrayBuffer) and `jwk` (`{ key_ops, ext, kty: "oct", k, alg }`) of an extractable HMAC key; a non-extractable one is Node's `InvalidAccessException` |
| `subtle.generateKey` | an HMAC key of `length` bits (default: the hash's block size, 512 or 1024) |
| `encrypt`, `decrypt`, `deriveBits`, `deriveKey`, `wrapKey`, `unwrapKey` | a `NotSupportedError` naming the operation |

`CryptoKey` carries `type` ("secret"), `extractable`, `algorithm` (`{ name: "HMAC", hash:
{ name }, length }`) and `usages`; its bytes are a private field the subtle API alone reads.
The errors are plain Errors whose `name` is the DOMException's.

## What a program sees

hono's HS256 / HS384 / HS512 JWTs sign and verify; RS256 and ES256 keys stop at `importKey`
with a `NotSupportedError` that names the algorithm (an asymmetric key store is a slice of
its own: RSA and ECDSA over a vendored or system library). `jwk`'s `verifyWithJwks` takes
HMAC `oct` keys only for the same reason. A JWK of an RSA key imports under Node and is
refused here: the one place the fixture `web/crypto` does not compare with Node.

## Verified

`tests/conformance/exhaustive/web/crypto.ts` (both profiles): the digest vectors of "abc" and
the empty string for the four hashes, an ArrayBuffer and a DataView as data, the HMAC-SHA256
vector of the quick brown fox under the key "key", raw and JWK import, verify against another
message and a short signature, export in both forms, a verify-only key refusing to sign,
SHA-384 signatures, generated key lengths, the usage, empty-key, MD5 and quota errors, the
UUID's shape and `getRandomValues` over integer views. hono's drivers basic-auth, bearer-auth,
combine, signed cookies, crypto utils, jwt, request-id and secure-headers agree with Node
(docs/real_projects.md).
