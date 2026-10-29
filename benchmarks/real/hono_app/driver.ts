// garnet real-project benchmark: a hono application (benchmarks/real/run.sh hono_app; the clone of
// hono at build/real/hono_app is build/real/hono). The app is driven through `app.fetch(new Request)`
// over a request mix, no socket: routing, middleware, the Context, the request's body and query, and
// the Response built, under garnet's Web standard objects (docs/web_fetch_api_design.md) and under
// Node's own. The checksum is every response's status, selected headers and body.
import { Hono } from "./src/hono.ts";
import { HTTPException } from "./src/http-exception.ts";
import { performance } from "node:perf_hooks";

const app = new Hono();
app.use("*", async (c, next) => {
  c.header("x-powered-by", "hono/garnet");
  await next();
  c.header("x-after", String(c.res.status));
});
app.get("/", (c) => c.text("root"));
app.get("/user/:id", (c) => c.json({ id: c.req.param("id"), q: c.req.query("q") ?? null, all: c.req.queries("tag") ?? [] }));
app.get("/user/:id/posts/:post", (c) => c.text(`${c.req.param("id")}/${c.req.param("post")}`));
app.post("/echo", async (c) => { const body = await c.req.json<{ n: number }>(); return c.json({ n: body.n + 1, ct: c.req.header("content-type") }); });
app.post("/form", async (c) => { const form = await c.req.parseBody(); return c.json(form); });
app.get("/html", (c) => c.html("<h1>hi</h1>"));
app.get("/redirect", (c) => c.redirect("/", 301));
app.get("/status", (c) => { c.status(202); return c.body("accepted"); });
app.get("/headers", (c) => c.text(c.req.header("x-in") ?? "none", 200, { "x-echo": c.req.header("x-in") ?? "none" }));
app.get("/throw", () => { throw new HTTPException(403, { message: "nope" }); });
app.get("/error", () => { throw new Error("boom"); });
app.onError((err, c) => err instanceof HTTPException ? err.getResponse() : c.text("error: " + err.message, 500));
app.notFound((c) => c.text("custom 404", 404));
const api = new Hono();
api.get("/items", (c) => c.json([1, 2, 3]));
api.delete("/items/:id", (c) => c.json({ deleted: c.req.param("id") }));
app.route("/api", api);
app.get("/static/*", (c) => c.text("static:" + c.req.path));
app.all("/any", (c) => c.text("method:" + c.req.method));

type Req = { method: string; path: string; body?: string; headers?: Record<string, string> };
const requests: Req[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/user/42?q=x&tag=a&tag=b" },
  { method: "GET", path: "/user/7/posts/9" },
  { method: "POST", path: "/echo", body: JSON.stringify({ n: 1 }), headers: { "content-type": "application/json" } },
  { method: "POST", path: "/form", body: "a=1&b=two&c=x+y", headers: { "content-type": "application/x-www-form-urlencoded" } },
  { method: "GET", path: "/html" },
  { method: "GET", path: "/redirect" },
  { method: "GET", path: "/status" },
  { method: "GET", path: "/headers", headers: { "x-in": "value" } },
  { method: "GET", path: "/throw" },
  { method: "GET", path: "/error" },
  { method: "GET", path: "/missing" },
  { method: "GET", path: "/api/items" },
  { method: "DELETE", path: "/api/items/5" },
  { method: "GET", path: "/static/css/app.css" },
  { method: "PUT", path: "/any" },
  { method: "HEAD", path: "/" },
];
function makeRequest(r: Req): Request {
  return new Request("http://localhost" + r.path, { method: r.method, body: r.body, headers: r.headers });
}
async function one(r: Req): Promise<string> {
  const res = await app.fetch(makeRequest(r));
  const body = await res.text();
  return `${r.method} ${r.path} -> ${res.status} ${res.headers.get("content-type") ?? "-"} ${res.headers.get("x-after") ?? "-"} ${res.headers.get("location") ?? "-"} ${res.headers.get("x-echo") ?? "-"} ${JSON.stringify(body)}`;
}
async function main(): Promise<void> {
  const lines: string[] = [];
  for (const r of requests) lines.push(await one(r));
  console.log(lines.join("\n"));
  const n = 20000;
  let checksum = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const r = requests[i % requests.length];
    const res = await app.fetch(makeRequest(r));
    checksum += res.status + (await res.text()).length;
  }
  const ms = performance.now() - t0;
  process.stderr.write(`hono_app: ${ms.toFixed(1)} ms (${(n / ms * 1000).toFixed(0)} req/s)\n`);
  console.log("checksum", checksum);
}
main();
