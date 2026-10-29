import { Hono } from "./src/hono.ts";
import { cache } from "./src/middleware/cache/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
let hits = 0;
app.get("/cached", cache({ cacheName: "survey", cacheControl: "max-age=10", onCacheNotAvailable: (reason) => console.log("cache unavailable:", String(reason).length > 0) }), (c) => c.text("hit " + ++hits));
async function main(): Promise<void> {
  section("cache");
  await show(app, "GET", "/cached", undefined, ["cache-control"]);
  await show(app, "GET", "/cached", undefined, ["cache-control"]);
}
main();
