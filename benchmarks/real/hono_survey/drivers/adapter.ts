import { Hono } from "./src/hono.ts";
import { env, getRuntimeKey } from "./src/helper/adapter/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.get("/", (c) => { const e = env<{ SURVEY_VAR?: string }>(c); return c.text(`runtime=${getRuntimeKey()} env=${typeof e} var=${e.SURVEY_VAR ?? "unset"}`); });
async function main(): Promise<void> {
  section("adapter");
  const res = await app.fetch(new Request("http://localhost/"));
  console.log(await res.text());
}
main();
