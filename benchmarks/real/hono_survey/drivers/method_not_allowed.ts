import { Hono } from "./src/hono.ts";
import { methodNotAllowed } from "./src/middleware/method-not-allowed/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use(methodNotAllowed({ app }));
app.get("/hello", (c) => c.text("get"));
app.post("/hello", (c) => c.text("post"));
app.get("/only", (c) => c.text("only get"));
const custom = new Hono();
custom.use(methodNotAllowed({ app: custom, onMethodNotAllowed: (c, methods) => c.json({ error: "nope", allow: methods }, 405, { Allow: methods.join(", ") }) }));
custom.delete("/x", (c) => c.text("deleted"));
async function main(): Promise<void> {
  section("method-not-allowed");
  await show(app, "PUT", "/hello", undefined, ["allow"]);
  await show(app, "GET", "/hello", undefined, ["allow"]);
  await show(app, "POST", "/only", undefined, ["allow"]);
  await show(app, "GET", "/nothing", undefined, ["allow"]);
  await show(custom, "GET", "/x", undefined, ["allow"]);
}
main();
