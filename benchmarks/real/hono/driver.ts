// garnet real-project benchmark: hono's routers (benchmarks/real/run.sh hono). The route table of hono's own
// router benchmark (benchmarks/routers/src/tool.mts) in each router, matched over the benchmark's requests many
// times; the checksum adds the matched handlers and the params, so the native and the Node runs must agree.
import { TrieRouter } from "./src/router/trie-router/index.ts";
import { RegExpRouter } from "./src/router/reg-exp-router/index.ts";
import { PatternRouter } from "./src/router/pattern-router/index.ts";
import { SmartRouter } from "./src/router/smart-router/index.ts";
import type { Router } from "./src/router.ts";
import { performance } from "node:perf_hooks";

const routes: { method: string; path: string }[] = [
  { method: "GET", path: "/user" },
  { method: "GET", path: "/user/comments" },
  { method: "GET", path: "/user/avatar" },
  { method: "GET", path: "/user/lookup/username/:username" },
  { method: "GET", path: "/user/lookup/email/:address" },
  { method: "GET", path: "/event/:id" },
  { method: "GET", path: "/event/:id/comments" },
  { method: "POST", path: "/event/:id/comment" },
  { method: "GET", path: "/map/:location/events" },
  { method: "GET", path: "/status" },
  { method: "GET", path: "/very/deeply/nested/route/hello/there" },
  { method: "GET", path: "/static/*" },
];
const requests: { method: string; path: string }[] = [
  { method: "GET", path: "/user" },
  { method: "GET", path: "/user/comments" },
  { method: "GET", path: "/user/lookup/username/hey" },
  { method: "GET", path: "/event/abcd1234/comments" },
  { method: "POST", path: "/event/abcd1234/comment" },
  { method: "GET", path: "/very/deeply/nested/route/hello/there" },
  { method: "GET", path: "/static/index.html" },
  { method: "GET", path: "/map/tokyo/events" },
  { method: "GET", path: "/user/lookup/email/a@b.c" },
  { method: "GET", path: "/nowhere/at/all" },
];

/** Distinct string objects with a request path's content: a server's paths arrive as fresh strings, and
 *  V8 caches a split's result by the string's identity (its StringSplitCache), which one object per request
 *  matched again and again would hit; the variants keep both engines doing the whole match. */
const VARIANTS = 64;
function pathVariants(path: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < VARIANTS; i++) out.push(path.split("").join(""));
  return out;
}
const requestPaths: string[][] = requests.map((r) => pathVariants(r.path));

function fill(router: Router<number>): void {
  for (let i = 0; i < routes.length; i++) router.add(routes[i].method, routes[i].path, i + 1);
}
/** The matches of every request `iterations` times: the handlers' sum and a count of the params. */
function bench(name: string, router: Router<number>, iterations: number): string {
  fill(router);
  // the first match builds the router's tables (lazily for the RegExpRouter); keep it out of the timing
  router.match("GET", "/status");
  let handlers = 0, params = 0;
  const t0 = performance.now();
  for (let it = 0; it < iterations; it++) {
    for (let r = 0; r < requests.length; r++) {
      const res = router.match(requests[r].method, requestPaths[r][it & (VARIANTS - 1)]);
      const matched = res[0];
      for (let m = 0; m < matched.length; m++) {
        handlers += matched[m][0];
        const p = matched[m][1];
        if (Array.isArray(p)) params += p.length; else if (p !== undefined) params++;   // a param map counts once (no walk of the router's object)
      }
      if (res[1] !== undefined) params += res[1].length;
    }
  }
  const ms = performance.now() - t0;
  process.stderr.write(`${name}: ${ms.toFixed(1)} ms (${(iterations * requests.length / ms * 1000 / 1e6).toFixed(2)} M matches/s)\n`);
  return `${name}: handlers ${handlers} params ${params}`;
}
function main(): void {
  const n = 100000;
  // The TrieRouter (object and string code; the time run.sh reports), then the routers that match through regular
  // expressions: the RegExpRouter (one alternation regexp per method whose empty captures mark the routes), the
  // PatternRouter (one regexp per route) and the SmartRouter (hono's default: the RegExpRouter when it can take the routes).
  const lines = [
    bench("TrieRouter", new TrieRouter<number>(), n),
    bench("RegExpRouter", new RegExpRouter<number>(), n),
    bench("PatternRouter", new PatternRouter<number>(), n),
    bench("SmartRouter", new SmartRouter<number>({ routers: [new RegExpRouter<number>(), new TrieRouter<number>()] }), n),
  ];
  console.log(lines.join("\n"));
}
main();
