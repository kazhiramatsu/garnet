import { Hono } from "./src/hono.ts";
import { hc } from "./src/client/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const app = new Hono()
  .get("/api/items/:id", (c) => c.json({ id: c.req.param("id"), q: c.req.query("q") ?? null }))
  .post("/api/echo", async (c) => c.json({ echoed: await c.req.json<unknown>() }))
  .get("/api/text", (c) => c.text("plain"));
type AppType = typeof app;
const client = hc<AppType>("http://localhost", { fetch: app.request });
async function main(): Promise<void> {
  section("client (hc)");
  const r1 = await client.api.items[":id"].$get({ param: { id: "7" } });
  console.log(r1.status, await r1.json());
  const r2 = await client.api.echo.$post({ json: { a: 1, b: [true] } });
  console.log(r2.status, await r2.json());
  const r3 = await client.api.text.$get();
  console.log(r3.status, await r3.text());
  console.log(client.api.items[":id"].$url({ param: { id: "9" } }).toString());
}
main();
