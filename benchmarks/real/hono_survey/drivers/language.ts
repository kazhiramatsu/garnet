import { Hono } from "./src/hono.ts";
import { languageDetector } from "./src/middleware/language/index.ts";
// the middleware augments the package root module (`declare module "../.."`): a type-only import puts that module in the program
import type {} from "./src/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use(languageDetector({ supportedLanguages: ["en", "ja", "fr"], fallbackLanguage: "en" }));
app.get("/", (c) => c.text("lang=" + c.get("language")));
const path = new Hono();
path.use(languageDetector({ supportedLanguages: ["en", "ja"], fallbackLanguage: "en", order: ["path"], lookupFromPathIndex: 0 }));
path.get("/:lang/page", (c) => c.text("path lang=" + c.get("language")));
async function main(): Promise<void> {
  section("language");
  await show(app, "GET", "/");
  await show(app, "GET", "/?lang=ja");
  await show(app, "GET", "/?lang=de");
  await show(app, "GET", "/", { headers: { cookie: "language=fr" } });
  await show(app, "GET", "/", { headers: { "accept-language": "fr-CA,fr;q=0.9,en;q=0.8" } });
  await show(app, "GET", "/", { headers: { "accept-language": "de,ja;q=0.5" } });
  await show(path, "GET", "/ja/page");
  await show(path, "GET", "/xx/page");
}
main();
