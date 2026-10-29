import { Hono } from "./src/hono.ts";
import { logger } from "./src/middleware/logger/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const lines: string[] = [];
const app = new Hono();
app.use(logger((str, ...rest) => { lines.push([str, ...rest].join(" ").replace(/\d+(\.\d+)?(ms|s)\b/g, "Nms")); }));
app.get("/ok", (c) => c.text("ok"));
app.get("/boom", () => { throw new Error("boom"); });
app.post("/items", (c) => c.json({ created: true }, 201));
async function main(): Promise<void> {
  section("logger");
  await show(app, "GET", "/ok");
  await show(app, "GET", "/missing");
  await show(app, "GET", "/boom");
  await show(app, "POST", "/items?x=1");
  for (const l of lines) console.log("LOG " + JSON.stringify(l));
}
main();
