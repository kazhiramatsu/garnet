import { Hono } from "./src/hono.ts";
import { contextStorage, getContext, tryGetContext } from "./src/middleware/context-storage/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono<{ Variables: { who: string } }>();
app.use(contextStorage());
app.use(async (c, next) => { c.set("who", "user-" + c.req.path.length); await next(); });
const whoAmI = (): string => getContext<{ Variables: { who: string } }>().get("who");
app.get("/who", (c) => c.text(whoAmI() + " " + String(tryGetContext() === c)));
async function main(): Promise<void> {
  section("context-storage");
  await show(app, "GET", "/who");
  console.log("outside:", tryGetContext() === undefined);
}
main();
