import { Hono } from "./src/hono.ts";
import { bodyLimit } from "./src/middleware/body-limit/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.post("/limit", bodyLimit({ maxSize: 10 }), async (c) => c.text("got " + (await c.req.text()).length));
app.post("/custom", bodyLimit({ maxSize: 5, onError: (c) => c.text("too big", 413) }), async (c) => c.text("ok " + (await c.req.text())));
async function main(): Promise<void> {
  section("body-limit");
  await show(app, "POST", "/limit", { body: "short" });
  await show(app, "POST", "/limit", { body: "this body is longer than ten bytes" });
  await show(app, "POST", "/custom", { body: "abc" });
  await show(app, "POST", "/custom", { body: "abcdefgh" });
  await show(app, "POST", "/limit", { body: "x".repeat(12), headers: { "content-length": "12" } });
}
main();
