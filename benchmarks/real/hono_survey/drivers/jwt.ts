import { Hono } from "./src/hono.ts";
import { jwt, sign, verify, decode } from "./src/middleware/jwt/index.ts";
import type { JwtVariables } from "./src/middleware/jwt/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const secret = "it-is-very-secret";
const app = new Hono<{ Variables: JwtVariables }>();
app.use("/auth/*", jwt({ secret, alg: "HS256" }));
app.get("/auth/page", (c) => { const p = c.get("jwtPayload"); return c.json({ sub: p.sub, role: p.role }); });
async function main(): Promise<void> {
  section("jwt");
  const token = await sign({ sub: "me", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  console.log("token parts:", token.split(".").length, "alg:", decode(token).header.alg);
  const payload = await verify(token, secret, "HS256");
  console.log("verified:", payload.sub, payload.role);
  await show(app, "GET", "/auth/page", { headers: { authorization: "Bearer " + token } });
  await show(app, "GET", "/auth/page", { headers: { authorization: "Bearer " + token + "x" } }, ["www-authenticate"]);
  await show(app, "GET", "/auth/page", undefined, ["www-authenticate"]);
}
main();
