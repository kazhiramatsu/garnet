// node:crypto: digests, HMAC, PBKDF2, random values, timingSafeEqual, errors.
import { createHash, createHmac, hash, getHashes, randomBytes, randomInt, randomUUID, timingSafeEqual, pbkdf2Sync, getRandomValues, randomFillSync, webcrypto } from "node:crypto";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
type Coded = Error & { code: string };
function main(): void {
  const out: string[] = [];
  out.push(createHash("md5").update("").digest("hex"));
  out.push(createHash("md5").update("abc").digest("hex"));
  out.push(createHash("sha1").update("abc").digest("hex"));
  out.push(createHash("sha256").update("abc").digest("hex"));
  out.push(createHash("sha512").update("abc").digest("hex"));
  out.push(createHash("SHA-256").update("a".repeat(1000)).digest("base64"));
  out.push(createHash("sha256").update("ab").update(Buffer.from("c")).digest("base64url"));
  out.push(createHash("sha256").update("616263", "hex").digest().toString("hex"));
  const h = createHash("sha1").update("ab");
  const h2 = h.copy();
  h.update("c");
  out.push(h.digest("hex") + " " + h2.digest("hex"));
  out.push(createHash("sha256").update("日本語").digest("hex"));
  out.push(createHash("sha512").update("x".repeat(111)).digest("hex").slice(0, 32) + " " + createHash("sha512").update("x".repeat(112)).digest("hex").slice(0, 32));
  out.push(createHash("sha1").update("y".repeat(55)).digest("hex") + " " + createHash("md5").update("y".repeat(56)).digest("hex"));
  out.push(createHmac("sha256", "key").update("The quick brown fox jumps over the lazy dog").digest("hex"));
  out.push(createHmac("sha1", "k".repeat(100)).update("data").digest("hex"));
  out.push(createHmac("md5", Buffer.from([1, 2, 3])).update("x").digest("base64"));
  out.push(createHmac("sha512", "").update("").digest("hex").slice(0, 32));
  out.push(String(hash("sha256", "abc")));
  out.push((hash("md5", "abc", "buffer") as Buffer).length + "");
  out.push(getHashes().filter((n) => n === "md5" || n === "sha1" || n === "sha256" || n === "sha512").join(","));
  out.push(pbkdf2Sync("password", "salt", 1, 20, "sha1").toString("hex"));
  out.push(pbkdf2Sync("password", "salt", 2, 20, "sha1").toString("hex"));
  out.push(pbkdf2Sync("password", "salt", 4096, 32, "sha256").toString("hex"));
  out.push(pbkdf2Sync("passwordPASSWORDpassword", "saltSALTsaltSALTsaltSALTsaltSALTsalt", 4096, 25, "sha1").toString("hex"));
  out.push(pbkdf2Sync("pass", "salt", 3, 70, "sha512").toString("hex").slice(0, 40));
  out.push(String(timingSafeEqual(Buffer.from("abc"), Buffer.from("abc"))) + " " + timingSafeEqual(Buffer.from("abc"), Buffer.from("abd")));
  try { timingSafeEqual(Buffer.from("a"), Buffer.from("ab")); } catch (e) { out.push((e as Coded).code + " " + (e as Error).message); }
  const rb = randomBytes(16);
  out.push(rb.length + " " + (rb instanceof Buffer) + " " + (randomBytes(16).equals(rb) === false));
  try { randomBytes(-1); } catch (e) { out.push((e as Coded).code + " " + (e as Error).message); }
  let ok = true;
  for (let i = 0; i < 200; i++) {
    const n = randomInt(5);
    if (n < 0 || n >= 5 || !Number.isInteger(n)) ok = false;
    const m = randomInt(-3, 3);
    if (m < -3 || m >= 3) ok = false;
  }
  out.push("randomInt " + ok);
  try { randomInt(3, 3); } catch (e) { out.push((e as Coded).code + " " + (e as Error).message); }
  out.push(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(randomUUID()) + " " + (randomUUID() !== randomUUID()));
  const u32 = new Uint32Array(4);
  getRandomValues(u32);
  out.push(u32.length + " " + webcrypto.randomUUID().length);
  const f = randomFillSync(Buffer.alloc(8), 2, 4);
  out.push(f.length + " " + f[0] + " " + f[7]);
  try { createHash("nope"); } catch (e) { out.push((e as Coded).code + " " + (e as Error).message); }
  try { const d = createHash("md5"); d.digest(); d.digest(); } catch (e) { out.push((e as Coded).code); }
  try { createHmac("nope", "k"); } catch (e) { out.push((e as Coded).code + " " + (e as Error).message); }
  out.push(typeof crypto.createHash + " " + typeof crypto.randomBytes);
  randomBytes(4, (err, buf) => { out.push("cb " + (err === null) + " " + buf.length); console.log(out.join("|")); });
}
main();
