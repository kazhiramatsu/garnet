// The Web Crypto global (lib/node/web/crypto.ts, docs/web_crypto_design.md): digests of known vectors,
// HMAC keys imported raw and as JWK, signed, verified, exported and generated, the key's properties,
// randomUUID and getRandomValues, and the errors of what is not provided. Node's own global is the
// oracle.
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const name = (e: unknown): string => (e as Error).name + (e instanceof Error ? "" : "?");
async function main(): Promise<void> {
  for (const alg of ["SHA-1", "SHA-256", "sha-384", "SHA-512"]) {
    console.log(alg, hex(await crypto.subtle.digest(alg, enc.encode("abc"))), hex(await crypto.subtle.digest({ name: alg }, new Uint8Array(0))).length);
  }
  console.log(hex(await crypto.subtle.digest("SHA-256", enc.encode("hello").buffer)), hex(await crypto.subtle.digest("SHA-256", new DataView(enc.encode("hello").buffer))));
  try { await crypto.subtle.digest("MD5", enc.encode("x")); } catch (e) { console.log("md5:", name(e)); }
  const raw = await crypto.subtle.importKey("raw", enc.encode("key"), { name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
  console.log(raw instanceof CryptoKey, raw.type, raw.extractable, raw.algorithm.name, raw.algorithm.hash.name, raw.algorithm.length, raw.usages.join(","));
  const data = enc.encode("The quick brown fox jumps over the lazy dog");
  const sig = await crypto.subtle.sign("HMAC", raw, data);
  console.log(hex(sig), sig.byteLength);
  console.log(await crypto.subtle.verify("HMAC", raw, sig, data), await crypto.subtle.verify({ name: "HMAC" }, raw, sig, enc.encode("other")), await crypto.subtle.verify("HMAC", raw, new Uint8Array(3), data));
  const exported = await crypto.subtle.exportKey("raw", raw);
  console.log(new TextDecoder().decode(exported), JSON.stringify(await crypto.subtle.exportKey("jwk", raw), Object.keys(await crypto.subtle.exportKey("jwk", raw)).sort()));
  const jwk = await crypto.subtle.importKey("jwk", { kty: "oct", k: "a2V5", alg: "HS256" }, { name: "HMAC", hash: { name: "SHA-256" } }, false, ["verify"]);
  console.log(jwk.extractable, jwk.usages.join(","), await crypto.subtle.verify("HMAC", jwk, sig, data));
  try { await crypto.subtle.exportKey("raw", jwk); } catch (e) { console.log("export non-extractable:", name(e)); }
  try { await crypto.subtle.sign("HMAC", jwk, data); } catch (e) { console.log("sign verify-only:", name(e)); }
  const s384 = await crypto.subtle.importKey("raw", enc.encode("k"), { name: "HMAC", hash: "SHA-384" }, false, ["sign"]);
  console.log((await crypto.subtle.sign("HMAC", s384, data)).byteLength, hex(await crypto.subtle.sign("HMAC", s384, data)).slice(0, 16));
  for (const [hash, length] of [["SHA-256", undefined], ["SHA-512", undefined], ["SHA-1", 256]] as [string, number | undefined][]) {
    const g = await crypto.subtle.generateKey(length === undefined ? { name: "HMAC", hash } : { name: "HMAC", hash, length }, true, ["sign"]);
    console.log(hash, g.algorithm.length, (await crypto.subtle.exportKey("raw", g)).byteLength, g.usages.join(","));
  }
  try { await crypto.subtle.importKey("raw", enc.encode("k"), { name: "HMAC", hash: "SHA-256" }, true, ["encrypt"]); } catch (e) { console.log("bad usage:", name(e)); }
  try { await crypto.subtle.importKey("raw", new Uint8Array(0), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]); } catch (e) { console.log("empty key:", name(e)); }
  try { await crypto.subtle.importKey("raw", enc.encode("k"), { name: "HMAC", hash: "MD5" }, true, ["sign"]); } catch (e) { console.log("md5 hmac:", name(e)); }
  const id = crypto.randomUUID();
  console.log(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), id !== crypto.randomUUID());
  const r = crypto.getRandomValues(new Uint8Array(16));
  console.log(r.length, r instanceof Uint8Array, crypto.getRandomValues(new Int32Array(4)).length, crypto.getRandomValues(new Uint8Array(0)).length);
  try { crypto.getRandomValues(new Float32Array(2)); } catch (e) { console.log("float:", name(e)); }
  try { crypto.getRandomValues(new DataView(new ArrayBuffer(4))); } catch (e) { console.log("dataview:", name(e)); }
  try { crypto.getRandomValues(new Uint8Array(70000)); } catch (e) { console.log("quota:", name(e)); }
  console.log(typeof crypto.subtle, crypto.subtle instanceof SubtleCrypto, crypto instanceof Crypto, typeof globalThis.crypto);
}
main();
