import { Hono } from "./src/hono.ts";
import { html, raw } from "./src/helper/html/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.get("/", (c) => c.html(html`<ul>${["<b>", "x & y", 3, null, true].map((v) => html`<li>${v}</li>`)}</ul>${raw("<hr>")}<p>${Promise.resolve("later")}</p>`));
async function main(): Promise<void> {
  section("html");
  await show(app, "GET", "/");
  const nested = html`<div>${html`<i>${"<"}</i>`} ${[1, [2, [3]]]}</div>`;
  console.log(String(await nested));
}
main();
