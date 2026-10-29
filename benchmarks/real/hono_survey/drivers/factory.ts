import { createFactory, createMiddleware } from "./src/helper/factory/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
type Env = { Variables: { user: string; count: number } };
const factory = createFactory<Env>({ initApp: (app) => { app.use(async (c, next) => { c.set("count", 0); await next(); }); } });
const tag = factory.createMiddleware(async (c, next) => { c.set("user", "u-" + c.req.path.length); await next(); });
const bump = createMiddleware<Env>(async (c, next) => { c.set("count", c.get("count") + 1); await next(); });
const handlers = factory.createHandlers(tag, bump, bump, (c) => c.text(`${c.get("user")} ${c.get("count")}`));
const app = factory.createApp();
app.get("/who", ...handlers);
async function main(): Promise<void> {
  section("factory");
  await show(app, "GET", "/who");
  await show(app, "GET", "/who/longer");
}
main();
