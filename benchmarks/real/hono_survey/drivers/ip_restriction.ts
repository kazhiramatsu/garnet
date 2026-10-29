import { Hono } from "./src/hono.ts";
import { ipRestriction } from "./src/middleware/ip-restriction/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
const app = new Hono();
const getIP = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header("x-ip") ?? "0.0.0.0";
app.use("/v4/*", ipRestriction(getIP, { denyList: ["192.168.1.0/24"], allowList: ["10.0.0.1", "172.16.0.0/12"] }));
app.use("/v6/*", ipRestriction(getIP, { allowList: ["::1", "2001:db8::/32"] }, (remote, c) => c.text("blocked " + remote.type + " " + remote.addr, 403)));
app.get("/v4/x", (c) => c.text("v4 ok"));
app.get("/v6/x", (c) => c.text("v6 ok"));
async function main(): Promise<void> {
  section("ip-restriction");
  for (const ip of ["10.0.0.1", "192.168.1.5", "172.20.3.4", "8.8.8.8"]) await show(app, "GET", "/v4/x", { headers: { "x-ip": ip } });
  for (const ip of ["::1", "2001:db8:1::5", "2001:db9::1"]) await show(app, "GET", "/v6/x", { headers: { "x-ip": ip } });
}
main();
