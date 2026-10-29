import { Hono } from "./src/hono.ts";
import { accepts } from "./src/helper/accepts/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.get("/lang", (c) => c.text(accepts(c, { header: "Accept-Language", supports: ["en", "ja", "zh"], default: "en" })));
app.get("/type", (c) => c.text(accepts(c, { header: "Accept", supports: ["application/json", "text/html"], default: "text/html" })));
app.get("/match", (c) => c.text(accepts(c, { header: "Accept-Language", supports: ["en", "ja"], default: "en", match: (accepts, config) => { const found = accepts.map((a) => a.type).find((t) => config.supports.includes(t)); return found ?? "fallback"; } })));
async function main(): Promise<void> {
  section("accepts");
  await show(app, "GET", "/lang", { headers: { "accept-language": "ja,en;q=0.8" } });
  await show(app, "GET", "/lang", { headers: { "accept-language": "de-DE,de;q=0.9" } });
  await show(app, "GET", "/lang");
  await show(app, "GET", "/type", { headers: { accept: "text/html;q=0.5, application/json" } });
  await show(app, "GET", "/match", { headers: { "accept-language": "fr, ja;q=0.1" } });
}
main();
