import { Hono } from "./src/hono.ts";
import { poweredBy } from "./src/middleware/powered-by/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use("/a/*", poweredBy());
app.use("/b/*", poweredBy({ serverName: "garnet" }));
app.get("/a/x", (c) => c.text("a"));
app.get("/b/x", (c) => c.text("b"));
async function main(): Promise<void> {
  section("powered-by");
  await show(app, "GET", "/a/x", undefined, ["x-powered-by"]);
  await show(app, "GET", "/b/x", undefined, ["x-powered-by"]);
}
main();
