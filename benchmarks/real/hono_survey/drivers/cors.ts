import { Hono } from "./src/hono.ts";
import { cors } from "./src/middleware/cors/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use("/api/*", cors({ origin: ["http://a.example", "http://b.example"], allowMethods: ["GET", "POST"], allowHeaders: ["X-Custom"], exposeHeaders: ["X-Exposed"], credentials: true, maxAge: 600 }));
app.use("/open/*", cors());
app.use("/fn/*", cors({ origin: (origin) => (origin.endsWith(".ok") ? origin : "") }));
app.get("/api/data", (c) => c.text("data"));
app.get("/open/data", (c) => c.text("open"));
app.get("/fn/data", (c) => c.text("fn"));
const H = ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-allow-credentials", "access-control-expose-headers", "access-control-max-age", "vary"];
async function main(): Promise<void> {
  section("cors");
  await show(app, "GET", "/api/data", { headers: { origin: "http://a.example" } }, H);
  await show(app, "GET", "/api/data", { headers: { origin: "http://evil.example" } }, H);
  await show(app, "OPTIONS", "/api/data", { headers: { origin: "http://b.example", "access-control-request-method": "POST", "access-control-request-headers": "X-Custom" } }, H);
  await show(app, "GET", "/open/data", { headers: { origin: "http://any.example" } }, H);
  await show(app, "OPTIONS", "/open/data", { headers: { origin: "http://any.example", "access-control-request-method": "DELETE" } }, H);
  await show(app, "GET", "/fn/data", { headers: { origin: "http://site.ok" } }, H);
  await show(app, "GET", "/fn/data", { headers: { origin: "http://site.ng" } }, H);
  await show(app, "GET", "/api/data", undefined, H);
}
main();
