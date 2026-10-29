import { Hono } from "./src/hono.ts";
import { csrf } from "./src/middleware/csrf/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use("/strict/*", csrf({ origin: "http://localhost" }));
app.use("/list/*", csrf({ origin: ["http://localhost", "http://other.example"] }));
app.use("/fn/*", csrf({ origin: (origin) => origin.endsWith(".example") }));
app.post("/strict/form", (c) => c.text("strict ok"));
app.post("/list/form", (c) => c.text("list ok"));
app.post("/fn/form", (c) => c.text("fn ok"));
app.get("/strict/form", (c) => c.text("get ok"));
const form = { "content-type": "application/x-www-form-urlencoded" };
async function main(): Promise<void> {
  section("csrf");
  await show(app, "POST", "/strict/form", { body: "a=1", headers: { ...form, origin: "http://localhost" } });
  await show(app, "POST", "/strict/form", { body: "a=1", headers: { ...form, origin: "http://evil.example" } });
  await show(app, "POST", "/strict/form", { body: "a=1", headers: form });
  await show(app, "POST", "/strict/form", { body: "{}", headers: { "content-type": "application/json" } });
  await show(app, "GET", "/strict/form");
  await show(app, "POST", "/list/form", { body: "a=1", headers: { ...form, origin: "http://other.example" } });
  await show(app, "POST", "/fn/form", { body: "a=1", headers: { ...form, origin: "http://x.example" } });
  await show(app, "POST", "/fn/form", { body: "a=1", headers: { ...form, origin: "http://x.test" } });
}
main();
