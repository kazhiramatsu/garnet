import { Hono } from "./src/hono.ts";
import { prettyJSON } from "./src/middleware/pretty-json/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use("/a/*", prettyJSON());
app.use("/b/*", prettyJSON({ space: 4, query: "p", force: true }));
app.get("/a/json", (c) => c.json({ a: 1, b: [1, 2, { c: "d" }], e: null }));
app.get("/a/text", (c) => c.text("not json"));
app.get("/b/json", (c) => c.json({ x: { y: "z" } }));
async function main(): Promise<void> {
  section("pretty-json");
  await show(app, "GET", "/a/json");
  await show(app, "GET", "/a/json?pretty");
  await show(app, "GET", "/a/text?pretty");
  await show(app, "GET", "/b/json");
  await show(app, "GET", "/b/json?p");
}
main();
