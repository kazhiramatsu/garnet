import { Hono } from "./src/hono.ts";
import { stream, streamText, streamSSE } from "./src/helper/streaming/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.get("/stream", (c) => stream(c, async (s) => { await s.write("a"); await s.writeln("b"); await s.sleep(1); await s.write(new Uint8Array([99])); }));
app.get("/text", (c) => streamText(c, async (s) => { await s.writeln("line1"); await s.writeln("line2"); }));
app.get("/sse", (c) => streamSSE(c, async (s) => { await s.writeSSE({ data: "hi", event: "greet", id: "1" }); await s.writeSSE({ data: "bye" }); }));
async function main(): Promise<void> {
  section("streaming");
  for (const path of ["/stream", "/text", "/sse"]) {
    const res = await app.fetch(new Request("http://localhost" + path));
    console.log(path, res.status, res.headers.get("content-type"), res.headers.get("transfer-encoding") ?? "-", JSON.stringify(await res.text()));
  }
}
main();
