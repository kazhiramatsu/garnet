import { Hono } from "./src/hono.ts";
import { getSignedCookie, setSignedCookie } from "./src/helper/cookie/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const secret = "cookie-secret";
const app = new Hono();
app.get("/set", async (c) => { await setSignedCookie(c, "sess", "user-1", secret, { path: "/" }); return c.text("set"); });
app.get("/read", async (c) => c.json({ sess: await getSignedCookie(c, secret, "sess"), all: await getSignedCookie(c, secret) }));
async function main(): Promise<void> {
  section("cookie (signed)");
  const r1 = await app.fetch(new Request("http://localhost/set"));
  const sc = r1.headers.getSetCookie()[0] ?? "";
  console.log(r1.status, "set-cookie shape:", sc.replace(/sess=user-1\.[A-Za-z0-9+/=%]+/, "sess=user-1.<sig>"));
  const cookie = sc.split(";")[0];
  const r2 = await app.fetch(new Request("http://localhost/read", { headers: { cookie } }));
  console.log(r2.status, await r2.text());
  const r3 = await app.fetch(new Request("http://localhost/read", { headers: { cookie: "sess=user-1.tampered" } }));
  console.log(r3.status, await r3.text());
}
main();
