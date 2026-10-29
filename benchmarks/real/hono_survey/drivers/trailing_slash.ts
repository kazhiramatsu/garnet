import { Hono } from "./src/hono.ts";
import { appendTrailingSlash, trimTrailingSlash } from "./src/middleware/trailing-slash/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const trim = new Hono();
trim.use(trimTrailingSlash());
trim.get("/about", (c) => c.text("about"));
const append = new Hono();
append.use(appendTrailingSlash());
append.get("/about/", (c) => c.text("about/"));
async function main(): Promise<void> {
  section("trailing-slash");
  await show(trim, "GET", "/about/", undefined, ["location"]);
  await show(trim, "GET", "/about", undefined, ["location"]);
  await show(trim, "GET", "/about/?q=1", undefined, ["location"]);
  await show(append, "GET", "/about", undefined, ["location"]);
  await show(append, "GET", "/about/", undefined, ["location"]);
  await show(append, "GET", "/missing", undefined, ["location"]);
}
main();
