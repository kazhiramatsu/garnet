import { Hono } from "./src/hono.ts";
import { bearerAuth } from "./src/middleware/bearer-auth/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use("/auth/*", bearerAuth({ token: "secret" }));
app.use("/multi/*", bearerAuth({ token: ["t1", "t2"] }));
app.use("/verify/*", bearerAuth({ verifyToken: async (token, c) => token === "dyn-" + c.req.path.length }));
app.get("/auth/page", (c) => c.text("secret page"));
app.get("/multi/page", (c) => c.text("multi"));
app.get("/verify/page", (c) => c.text("verified"));
async function main(): Promise<void> {
  section("bearer-auth");
  await show(app, "GET", "/auth/page", undefined, ["www-authenticate"]);
  await show(app, "GET", "/auth/page", { headers: { authorization: "Bearer wrong" } }, ["www-authenticate"]);
  await show(app, "GET", "/auth/page", { headers: { authorization: "Basic abc" } }, ["www-authenticate"]);
  await show(app, "GET", "/auth/page", { headers: { authorization: "Bearer secret" } });
  await show(app, "GET", "/multi/page", { headers: { authorization: "Bearer t2" } });
  await show(app, "GET", "/verify/page", { headers: { authorization: "Bearer dyn-12" } });
  await show(app, "GET", "/verify/page", { headers: { authorization: "Bearer dyn-1" } }, ["www-authenticate"]);
}
main();
