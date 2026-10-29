import { Hono } from "./src/hono.ts";
import { toSSG, ssgParams, disableSSG, onlySSG } from "./src/helper/ssg/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const written: Record<string, string> = {};
const fs = {
  writeFile: async (path: string, data: string | Uint8Array): Promise<void> => { written[path] = typeof data === "string" ? data : `<${data.byteLength} bytes>`; },
  mkdir: async (_path: string, _options: { recursive: boolean }): Promise<void> => {},
};
const app = new Hono();
app.get("/", (c) => c.html("<h1>home</h1>"));
app.get("/about", (c) => c.html("<p>about</p>"));
app.get("/api/data", (c) => c.json({ a: 1 }));
app.get("/posts/:id", ssgParams([{ id: "1" }, { id: "2" }]), (c) => c.html(`<p>post ${c.req.param("id")}</p>`));
app.get("/dynamic", disableSSG(), (c) => c.text("not generated"));
app.get("/static-only", onlySSG(), (c) => c.text("ssg only"));
async function main(): Promise<void> {
  section("ssg");
  const result = await toSSG(app, fs, { dir: "./out", concurrency: 1 });
  console.log("success:", result.success, "error:", result.error?.message ?? "-");
  console.log("files:", (result.files ?? []).slice().sort().join(", "));
  for (const k of Object.keys(written).sort()) console.log("  " + k + " = " + written[k]);
  const res = await app.fetch(new Request("http://localhost/static-only"));
  console.log("/static-only at runtime:", res.status);
}
main();
