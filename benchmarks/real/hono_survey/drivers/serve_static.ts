import { Hono } from "./src/hono.ts";
import { serveStatic } from "./src/middleware/serve-static/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const files: Record<string, string> = { "public/index.html": "<h1>index</h1>", "public/css/app.css": "body{margin:0}", "public/data.json": "{\"a\":1}", "public/sub/index.html": "<p>sub</p>" };
const app = new Hono();
app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/static/, ""), getContent: async (path) => files[path] ?? null, isDir: (path) => path === "public/sub", onNotFound: (path, c) => { c.header("x-not-found", path); } }));
app.get("/static/*", (c) => c.text("fallthrough " + c.req.path, 404));
async function main(): Promise<void> {
  section("serve-static");
  await show(app, "GET", "/static/index.html");
  await show(app, "GET", "/static/");
  await show(app, "GET", "/static/css/app.css");
  await show(app, "GET", "/static/data.json");
  await show(app, "GET", "/static/sub/");
  await show(app, "GET", "/static/missing.txt", undefined, ["x-not-found"]);
}
main();
