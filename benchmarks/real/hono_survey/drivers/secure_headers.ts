import { Hono } from "./src/hono.ts";
import { secureHeaders, NONCE } from "./src/middleware/secure-headers/index.ts";
// the middleware augments the package root module (`declare module "../.."`): a type-only import puts that module in the program
import type {} from "./src/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const app = new Hono();
app.use("/default/*", secureHeaders());
app.use("/csp/*", secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: [NONCE, "https://cdn.example"] }, xFrameOptions: false, permissionsPolicy: { camera: [], geolocation: ["self"] } }));
app.get("/default/x", (c) => c.text("d"));
app.get("/csp/x", (c) => c.text("c"));
async function main(): Promise<void> {
  section("secure-headers");
  for (const path of ["/default/x", "/csp/x"]) {
    const res = await app.fetch(new Request("http://localhost" + path));
    const names = [...res.headers.keys()].sort();
    console.log(path, res.status, names.join(","));
    for (const n of names) {
      const v = (res.headers.get(n) ?? "").replace(/'nonce-[A-Za-z0-9+/=]+'/g, (m) => `'nonce-<${m.length - 9}>'`);
      if (n !== "content-type") console.log("  " + n + ": " + v);
    }
  }
}
main();
