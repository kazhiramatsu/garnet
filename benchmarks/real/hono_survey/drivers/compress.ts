import { Hono } from "./src/hono.ts";
import { compress } from "./src/middleware/compress/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use(compress());
app.get("/text", (c) => c.text("hono ".repeat(500)));
app.get("/small", (c) => c.text("tiny"));
app.get("/json", (c) => c.json({ data: "x".repeat(2000) }));
async function main(): Promise<void> {
  section("compress");
  for (const [path, enc] of [["/text", "gzip"], ["/text", "deflate"], ["/text", "br"], ["/small", "gzip"], ["/json", "gzip"], ["/text", ""]]) {
    const res = await app.fetch(new Request("http://localhost" + path, { headers: enc ? { "accept-encoding": enc } : {} }));
    const buf = await res.arrayBuffer();
    console.log(path, enc || "(none)", "->", res.status, "content-encoding=" + (res.headers.get("content-encoding") ?? "-"), "bytes=" + buf.byteLength);
  }
}
main();
