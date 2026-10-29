import { Hono } from "./src/hono.ts";
import { mount } from "./src/middleware/mount/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const sub = new Hono();
sub.get("/hello", (c) => c.text("sub hello " + c.req.path));
sub.get("/", (c) => c.text("sub root " + c.req.path));
const app = new Hono();
app.all("/sub/*", mount(sub.fetch));
app.all("/sub", mount(sub.fetch));
app.all("/raw/*", mount(sub.fetch, { replaceRequest: false }));
app.all("/opt/*", mount(sub.fetch, (c) => [c.req.header("x-opt")]));
app.get("/", (c) => c.text("root"));
async function main(): Promise<void> {
  section("mount");
  await show(app, "GET", "/sub/hello");
  await show(app, "GET", "/sub");
  await show(app, "GET", "/sub/");
  await show(app, "GET", "/raw/hello");
  await show(app, "GET", "/opt/hello", { headers: { "x-opt": "v" } });
  await show(app, "GET", "/");
}
main();
