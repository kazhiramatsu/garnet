import { Hono } from "./src/hono.ts";
import { requestId } from "./src/middleware/request-id/index.ts";
import type { RequestIdVariables } from "./src/middleware/request-id/index.ts";
// the middleware augments the package root module (`declare module "../.."`): a type-only import puts that module in the program
import type {} from "./src/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const app = new Hono<{ Variables: RequestIdVariables }>();
app.use("/a/*", requestId());
app.use("/b/*", requestId({ generator: (c) => "fixed-" + c.req.path.length, headerName: "X-Trace-Id" }));
app.get("/a/x", (c) => c.text(c.get("requestId")));
app.get("/b/x", (c) => c.text(c.get("requestId")));
async function main(): Promise<void> {
  section("request-id");
  const r1 = await app.fetch(new Request("http://localhost/a/x"));
  const id = await r1.text();
  console.log("uuid shape:", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), "header matches:", r1.headers.get("x-request-id") === id);
  const r2 = await app.fetch(new Request("http://localhost/a/x", { headers: { "x-request-id": "given-id" } }));
  console.log("given:", await r2.text(), r2.headers.get("x-request-id"));
  const r3 = await app.fetch(new Request("http://localhost/b/x"));
  console.log("generator:", await r3.text(), r3.headers.get("x-trace-id"));
}
main();
