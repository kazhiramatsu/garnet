import { Hono } from "./src/hono.ts";
import { getCookie, setCookie, deleteCookie } from "./src/helper/cookie/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.get("/read", (c) => c.json({ all: getCookie(c), a: getCookie(c, "a"), secure: getCookie(c, "s", "secure"), host: getCookie(c, "h", "host") }));
app.get("/set", (c) => {
  setCookie(c, "a", "1", { path: "/", maxAge: 60, httpOnly: true, sameSite: "Lax" });
  setCookie(c, "b", "sp ace;", { domain: "example.com", secure: true, expires: new Date("2030-01-01T00:00:00Z") });
  setCookie(c, "s", "v", { prefix: "secure", secure: true });
  setCookie(c, "h", "v", { prefix: "host", secure: true, path: "/" });
  setCookie(c, "p", "x", { partitioned: true, secure: true, sameSite: "None", priority: "High" });
  deleteCookie(c, "old", { path: "/" });
  return c.text("set");
});
async function main(): Promise<void> {
  section("cookie");
  const r1 = await app.fetch(new Request("http://localhost/read", { headers: { cookie: "a=1; b=two%20words; __Secure-s=sv; __Host-h=hv; weird=%E3%81%82" } }));
  console.log(r1.status, await r1.text());
  const r2 = await app.fetch(new Request("http://localhost/set"));
  console.log(r2.status, await r2.text());
  for (const sc of r2.headers.getSetCookie()) console.log("  " + sc);
}
main();
