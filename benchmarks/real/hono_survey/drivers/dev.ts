import { Hono } from "./src/hono.ts";
import { showRoutes, getRouterName, inspectRoutes } from "./src/helper/dev/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.get("/", (c) => c.text("root"));
app.post("/items", (c) => c.text("post"));
app.use("/admin/*", async (c, next) => { await next(); });
app.get("/admin/users/:id", (c) => c.text(c.req.param("id")));
const api = new Hono();
api.get("/ping", (c) => c.text("pong"));
app.route("/api", api);
async function main(): Promise<void> {
  section("dev");
  console.log("router:", getRouterName(app));
  showRoutes(app, { colorize: false });
  showRoutes(app, { verbose: true, colorize: false });
  console.log(inspectRoutes(app).map((r) => `${r.method} ${r.path} mw=${r.isMiddleware}`).join("; "));
}
main();
