// The Proxy operations root their values in a shadow frame (Session 356): traps that allocate
// enough to run the collector many times, with the proxy, target, handler, key, receiver and the
// trap's result alive across the trap call; a nested proxied operation inside a trap; a trap that
// throws through the frame; a trap replaced from inside a trap. Run under GC stress as well.
function churn(n: number): string[] { const a: string[] = []; for (let i = 0; i < n; i++) a.push("s" + i + "x".repeat(i % 7)); return a; }
function main() {
  const out: string[] = [];
  let calls = 0;
  const inner: any = new Proxy({ v: 1 }, { get(t: any, k: any, r: any) { churn(50); return k === "v" ? t.v + churn(10).length : undefined; } });
  const handler: any = {
    get(t: any, k: any, r: any) {
      calls++;
      const junk = churn(200);
      const nested = inner.v;                       // a proxied read inside the trap
      if (k === "boom") throw new Error("boom:" + junk.length);
      return String(t[k]) + ":" + nested + ":" + (r === p ? "recv" : "other") + ":" + (typeof k);
    },
    set(t: any, k: any, v: any, r: any) { churn(100); t[k] = v; return true; },
    has(t: any, k: any) { churn(100); return k in t || k === "ghost"; },
  };
  const target: any = { a: 1, b: "two" };
  const p: any = new Proxy(target, handler);
  for (let i = 0; i < 300; i++) {
    p["c" + (i % 5)] = i;
    const s = p.a + "|" + p.b + "|" + p["c" + (i % 5)] + "|" + ("ghost" in p) + "|" + ("zz" in p);
    if (i % 100 === 0) out.push(s);
  }
  try { p.boom; } catch (e: any) { out.push(e.message.slice(0, 4)); }
  const s2 = p.a; out.push(s2);                      // the frame is clean after the throw
  handler.get = function (t: any, k: any) { handler.get = function () { return "third"; }; churn(500); return "second:" + String(t[k]); };
  out.push(p.a, p.a);
  out.push(String(calls), Object.keys(target).join(","));
  console.log(out.join("\n"));
}
main();
