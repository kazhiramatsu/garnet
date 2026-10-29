import { getPath, getQueryParam, getQueryParams, mergePath, checkOptionalParameter, decodeURIComponent_, tryDecodeURIComponent } from "./src/utils/url.ts";
import { getMimeType, getExtension } from "./src/utils/mime.ts";
import { encodeBase64, decodeBase64, encodeBase64Url, decodeBase64Url } from "./src/utils/encode.ts";
import { parse, serialize } from "./src/utils/cookie.ts";
import { getFilePath, getFilePathWithoutDefaultDocument } from "./src/utils/filepath.ts";
import { parseAccept } from "./src/utils/accept.ts";
import { getColorEnabled } from "./src/utils/color.ts";
import { bufferToString, bufferToFormData } from "./src/utils/buffer.ts";
import { escapeToBuffer, stringBufferToString } from "./src/utils/html.ts";
import { section } from "./garnet-survey-_lib.ts";
async function main(): Promise<void> {
  section("utils");
  console.log(getPath(new Request("http://localhost/a/b?c=1#d")), getQueryParam("http://x/?a=1&b=2&a=3", "a"), getQueryParam("http://x/?a=1&b=%E3%81%82", "b"), JSON.stringify(getQueryParams("http://x/?a=1&a=2&b")));
  console.log(mergePath("/api", "/users"), mergePath("/api/", "users/"), mergePath("", "/"), JSON.stringify(checkOptionalParameter("/api/animals/:type?")), JSON.stringify(checkOptionalParameter("/api/:a")));
  try { console.log(decodeURIComponent_("%E3%81%82%20%ZZ")); } catch (e) { console.log("decodeURIComponent_ throws", e instanceof URIError); }
  console.log(decodeURIComponent_("%E3%81%82%20"), tryDecodeURIComponent("%E3%81%82"), tryDecodeURIComponent("%ZZ"));
  console.log(getMimeType("a.json"), getMimeType("x.unknown"), getMimeType("a.html", { html: "text/custom" }), getExtension("image/png"));
  const bytes = new TextEncoder().encode("hello ✓");
  console.log(encodeBase64(bytes.buffer), bufferToString(decodeBase64(encodeBase64(bytes.buffer)).buffer as ArrayBuffer), encodeBase64Url(bytes.buffer), new TextDecoder().decode(decodeBase64Url(encodeBase64Url(bytes.buffer))));
  console.log(JSON.stringify(parse("a=1; b=%20x; __Secure-c=3", "b")), JSON.stringify(parse("a=1; b=2")), serialize("k", "v w", { path: "/", maxAge: 10, httpOnly: true, sameSite: "Strict" }));   // parseSigned: Web Crypto, the cookie_signed driver
  console.log(getFilePath({ filename: "css/app.css", root: "public" }), getFilePath({ filename: "dir/", root: "public", defaultDocument: "index.html" }), getFilePathWithoutDefaultDocument({ filename: "../etc/passwd" }), getFilePath({ filename: "a.b.c", root: "/r/" }));
  console.log(JSON.stringify(parseAccept("text/html, application/json;q=0.9, */*;q=0.1")));
  console.log("color:", getColorEnabled());
  const fd = await bufferToFormData(new TextEncoder().encode("a=1&b=2").buffer as ArrayBuffer, "application/x-www-form-urlencoded");
  console.log("formdata:", fd.get("a"), fd.get("b"));
  const buf: [string] = [""]; escapeToBuffer("<a href='x'>&\"</a>", buf); console.log(buf[0], String(await stringBufferToString(["tail", Promise.resolve("<p>"), "head "], undefined)));   // a String wrapper: its primitive (console.log prints an inspect form of the wrapper)
}
main();
