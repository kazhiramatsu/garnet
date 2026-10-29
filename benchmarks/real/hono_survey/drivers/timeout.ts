import { Hono } from "./src/hono.ts";
import { timeout } from "./src/middleware/timeout/index.ts";
import { HTTPException } from "./src/http-exception.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const app = new Hono();
app.get("/slow", timeout(30), async (c) => { await sleep(120); return c.text("slow done"); });
app.get("/fast", timeout(200), async (c) => { await sleep(5); return c.text("fast done"); });
app.get("/custom", timeout(30, (c) => new HTTPException(408, { message: "custom timeout for " + c.req.path })), async (c) => { await sleep(120); return c.text("never"); });
async function main(): Promise<void> {
  section("timeout");
  await show(app, "GET", "/slow");
  await show(app, "GET", "/fast");
  await show(app, "GET", "/custom");
}
main();
