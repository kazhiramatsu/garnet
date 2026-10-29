import { Hono } from "./src/hono.ts";
import { basicAuth } from "./src/middleware/basic-auth/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use("/auth/*", basicAuth({ username: "hono", password: "pw" }));
app.use("/verify/*", basicAuth({ verifyUser: async (user, pass) => user === "a" && pass === "b", realm: "survey" }));
app.get("/auth/page", (c) => c.text("secret"));
app.get("/verify/page", (c) => c.text("verified"));
async function main(): Promise<void> {
  section("basic-auth");
  await show(app, "GET", "/auth/page", undefined, ["www-authenticate"]);
  await show(app, "GET", "/auth/page", { headers: { authorization: "Basic " + btoa("hono:wrong") } }, ["www-authenticate"]);
  await show(app, "GET", "/auth/page", { headers: { authorization: "Basic " + btoa("hono:pw") } });
  await show(app, "GET", "/verify/page", { headers: { authorization: "Basic " + btoa("a:b") } });
  await show(app, "GET", "/verify/page", { headers: { authorization: "Basic " + btoa("a:c") } }, ["www-authenticate"]);
}
main();
