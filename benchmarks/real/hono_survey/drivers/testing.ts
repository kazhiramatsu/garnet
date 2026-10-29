import { Hono } from "./src/hono.ts";
import { testClient } from "./src/helper/testing/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const app = new Hono().get("/search", (c) => c.json({ q: c.req.query("q") ?? "" })).post("/items/:id", (c) => c.json({ id: c.req.param("id"), method: c.req.method }));
async function main(): Promise<void> {
  section("testing (testClient)");
  const client = testClient(app);
  const r1 = await client.search.$get({ query: { q: "needle" } });
  console.log(r1.status, await r1.json());
  const r2 = await client.items[":id"].$post({ param: { id: "3" } });
  console.log(r2.status, await r2.json());
}
main();
