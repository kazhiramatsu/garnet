import { Hono } from "./src/hono.ts";
import { validator } from "./src/validator/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.post("/json", validator("json", (value, c) => { const v = value as { name?: string; age?: number }; if (typeof v.name !== "string") return c.text("name required", 400); return { name: v.name, age: v.age ?? 0 }; }), (c) => c.json(c.req.valid("json")));
app.post("/form", validator("form", (value) => ({ fields: Object.keys(value).sort(), tags: value["tag"] })), (c) => c.json(c.req.valid("form")));
app.get("/query", validator("query", (value, c) => { const q = value["q"]; if (!q) return c.text("q required", 400); return { q, page: Number(value["page"] ?? 1) }; }), (c) => c.json(c.req.valid("query")));
app.get("/hp/:id", validator("param", (value) => ({ id: Number(value["id"]) })), validator("header", (value) => ({ ua: value["x-ua"] ?? "none" })), (c) => c.json({ ...c.req.valid("param"), ...c.req.valid("header") }));
const form = { "content-type": "application/x-www-form-urlencoded" };
const json = { "content-type": "application/json" };
async function main(): Promise<void> {
  section("validator");
  await show(app, "POST", "/json", { body: JSON.stringify({ name: "n", age: 3 }), headers: json });
  await show(app, "POST", "/json", { body: JSON.stringify({ age: 3 }), headers: json });
  await show(app, "POST", "/json", { body: "not json", headers: json });
  await show(app, "POST", "/json", { body: "{}", headers: { "content-type": "text/plain" } });
  await show(app, "POST", "/form", { body: "a=1&tag=x&tag=y", headers: form });
  await show(app, "GET", "/query?q=hi&page=2");
  await show(app, "GET", "/query");
  await show(app, "GET", "/hp/12", { headers: { "x-ua": "garnet" } });
}
main();
