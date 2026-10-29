// The hono middleware survey's request helper (benchmarks/real/hono_survey/run.sh): one request
// through app.fetch, printed as the status, the headers asked for, and the body (truncated).
import type { Hono } from "./src/hono.ts";
export type App = Hono<any, any, any>;
export type Init = { body?: string; headers?: Record<string, string> };
export async function show(app: App, method: string, path: string, init?: Init, pick: string[] = ["content-type"]): Promise<void> {
  const res = await app.fetch(new Request("http://localhost" + path, { method, body: init?.body, headers: init?.headers }));
  const hs = pick.map((h) => `${h}=${res.headers.get(h) ?? "-"}`).join(" ");
  let body = await res.text();
  if (body.length > 400) body = body.slice(0, 400) + `...(${body.length})`;
  console.log(`${method} ${path} -> ${res.status} ${hs} ${JSON.stringify(body)}`);
}
export function section(name: string): void { console.log(`## ${name}`); }
