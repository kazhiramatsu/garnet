import { Hono } from "./src/hono.ts";
import { compress } from "./src/middleware/compress/index.ts";
import { etag } from "./src/middleware/etag/index.ts";
import { section } from "./garnet-survey-_lib.ts";
// The compressed bytes depend on the zlib build (Node may bundle its own): each body is decoded with
// DecompressionStream and compared with what the handler sent, and only that is printed.
const text = "hono ".repeat(500);
const json = { data: "x".repeat(2000) };
const app = new Hono();
app.use("/etag/*", etag());
app.use(compress());
app.get("/text", (c) => c.text(text));
app.get("/small", (c) => c.text("tiny"));
app.get("/json", (c) => c.json(json));
app.get("/sized", (c) => { c.header("Content-Length", "4"); return c.text("tiny"); });
app.get("/no-transform", (c) => { c.header("Cache-Control", "no-transform"); return c.text(text); });
app.get("/image", (c) => c.body(new Uint8Array(4000), 200, { "Content-Type": "image/png" }));
app.get("/etag/page", (c) => c.text(text));
app.get("/stream", (c) => c.body(new ReadableStream<Uint8Array>({ start(ctl) { for (let i = 0; i < 4; i++) ctl.enqueue(new TextEncoder().encode(text)); ctl.close(); } }), 200, { "Content-Type": "text/plain" }));
const deflateOnly = new Hono();
deflateOnly.use(compress({ encoding: "deflate", threshold: 10 }));
deflateOnly.get("/", (c) => c.text(text));
async function decoded(res: Response): Promise<string> {
  const enc = res.headers.get("content-encoding");
  if (enc === null || res.body === null) return await res.text();
  return await new Response(res.body.pipeThrough(new DecompressionStream(enc as CompressionFormat))).text();
}
async function main(): Promise<void> {
  section("compress");
  const expected: Record<string, string> = { "/text": text, "/small": "tiny", "/json": JSON.stringify(json), "/sized": "tiny", "/no-transform": text, "/etag/page": text, "/stream": text.repeat(4) };
  const cases: [string, string, string?][] = [["/text", "gzip"], ["/text", "deflate"], ["/text", "br"], ["/text", "gzip;q=0.5, deflate;q=0.8"], ["/text", "*"], ["/small", "gzip"], ["/json", "gzip"],
    ["/text", ""], ["/sized", "gzip"], ["/no-transform", "gzip"], ["/image", "gzip"], ["/etag/page", "gzip"], ["/stream", "deflate"], ["/text", "gzip", "HEAD"]];
  for (const [path, enc, method] of cases) {
    const res = await app.fetch(new Request("http://localhost" + path, { method: method ?? "GET", headers: enc ? { "accept-encoding": enc } : {} }));
    const body = method === "HEAD" ? "" : await decoded(res);
    const want = method === "HEAD" ? "" : expected[path];
    console.log(method ?? "GET", path, enc || "(none)", "->", res.status, "content-encoding=" + (res.headers.get("content-encoding") ?? "-"),
      "vary=" + (res.headers.get("vary") ?? "-"), "etag=" + (res.headers.get("etag") ?? "-"),
      "content-length=" + (res.headers.get("content-length") ?? "-"), "decoded=" + body.length, want === undefined ? "" : "same=" + (body === want));
  }
  const res = await deflateOnly.fetch(new Request("http://localhost/", { headers: { "accept-encoding": "gzip, deflate" } }));
  console.log("deflate only ->", res.headers.get("content-encoding"), (await decoded(res)) === text);
}
main();
