import { Hono } from "./src/hono.ts";
import { etag } from "./src/middleware/etag/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use("/strong/*", etag());
app.use("/weak/*", etag({ weak: true }));
app.get("/strong/a", (c) => c.text("hello etag"));
app.get("/weak/a", (c) => c.json({ a: 1 }));
async function main(): Promise<void> {
  section("etag");
  await show(app, "GET", "/strong/a", undefined, ["etag"]);
  await show(app, "GET", "/strong/a", { headers: { "if-none-match": '"4d4dfd6cf3e3f5dcad6c1d6b4a2b0a2eb9c5e73d"' } }, ["etag"]);
  await show(app, "GET", "/weak/a", undefined, ["etag"]);
  await show(app, "GET", "/strong/a", { headers: { "if-none-match": '"nope"' } }, ["etag"]);
}
main();
