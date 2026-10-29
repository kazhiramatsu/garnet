import { sha1, sha256 } from "./src/utils/crypto.ts";
import { timingSafeEqual } from "./src/utils/buffer.ts";
import { section } from "./garnet-survey-_lib.ts";
async function main(): Promise<void> {
  section("crypto utils");
  console.log(await sha1("abc"), await sha256("abc"));
  console.log(await timingSafeEqual("a", "a"), await timingSafeEqual("a", "b"), await timingSafeEqual("a", "aa"));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
  console.log("digest bytes:", digest.byteLength);
}
main();
