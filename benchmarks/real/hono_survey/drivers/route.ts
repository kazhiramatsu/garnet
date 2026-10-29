import { Hono } from "./src/hono.ts";
import { matchedRoutes, routePath, basePath, baseRoutePath } from "./src/helper/route/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const api = new Hono().basePath("/api");
api.use("/users/*", async (c, next) => { c.header("x-mw", matchedRoutes(c).length.toString()); await next(); });
api.get("/users/:id", (c) => c.text([matchedRoutes(c).map((r) => r.method + " " + r.path).join(","), routePath(c), basePath(c), baseRoutePath(c)].join(" | ")));
const app = new Hono();
app.route("/v1", api);
app.get("/plain", (c) => c.text(routePath(c) + " " + basePath(c)));
async function main(): Promise<void> {
  section("route");
  await show(app, "GET", "/v1/api/users/42", undefined, ["x-mw"]);
  await show(app, "GET", "/plain");
}
main();
