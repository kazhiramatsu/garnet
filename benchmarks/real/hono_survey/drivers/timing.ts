import { Hono } from "./src/hono.ts";
import { timing, startTime, endTime, setMetric } from "./src/middleware/timing/index.ts";
import type { TimingVariables } from "./src/middleware/timing/index.ts";
// the middleware augments the package root module (`declare module "../.."`): a type-only import puts that module in the program
import type {} from "./src/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const app = new Hono<{ Variables: TimingVariables }>();
app.use(timing({ totalDescription: "total time" }));
app.get("/", async (c) => {
  startTime(c, "db", "database");
  await sleep(3);
  endTime(c, "db");
  setMetric(c, "cache", 2.5, "cache hit");
  setMetric(c, "region", "us-east");
  return c.text("timed");
});
async function main(): Promise<void> {
  section("timing");
  const res = await app.fetch(new Request("http://localhost/"));
  const st = (res.headers.get("server-timing") ?? "-").replace(/dur=\d+(\.\d+)?/g, "dur=N");
  console.log(res.status, await res.text(), st);
}
main();
