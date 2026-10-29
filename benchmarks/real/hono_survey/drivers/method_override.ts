import { Hono } from "./src/hono.ts";
import { methodOverride } from "./src/middleware/method-override/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use("/posts/*", methodOverride({ app }));
app.use("/hdr/*", methodOverride({ app, header: "X-HTTP-Method-Override" }));
app.use("/q/*", methodOverride({ app, query: "_method" }));
app.delete("/posts/:id", (c) => c.text("deleted " + c.req.param("id")));
app.put("/hdr/:id", (c) => c.text("put " + c.req.param("id")));
app.patch("/q/:id", (c) => c.text("patched " + c.req.param("id")));
app.post("/posts/:id", (c) => c.text("plain post"));
const form = { "content-type": "application/x-www-form-urlencoded" };
async function main(): Promise<void> {
  section("method-override");
  await show(app, "POST", "/posts/1", { body: "_method=DELETE&x=1", headers: form });
  await show(app, "POST", "/posts/2", { body: "x=1", headers: form });
  await show(app, "POST", "/hdr/3", { headers: { "x-http-method-override": "PUT" } });
  await show(app, "POST", "/q/4?_method=PATCH");
}
main();
