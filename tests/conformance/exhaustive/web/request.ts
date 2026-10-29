// The Request class (docs/web_fetch_api_design.md): the URL parsed and serialized, a URL object
// and a Request as the input, the method normalized, a GET with a body, the headers from the init
// and from the input, a string body's content type, the body read once, clone, the option
// defaults and the options copied from the input, credentials in the URL, the signal, formData of
// urlencoded and multipart bodies, the object's tag.
function names(e: unknown): string { return (e as Error).constructor.name; }
async function main() {
  const out: unknown[] = [];
  const r = new Request("http://example.com/a/b?x=1#frag");
  out.push(r.url, r.method, r.bodyUsed, r.body, [...r.headers].length, r.cache, r.credentials, r.mode, r.redirect, r.referrer, r.referrerPolicy, r.integrity, r.keepalive, r.destination);
  out.push(new Request("HTTP://Example.COM:80/p/../q").url, new Request(new URL("http://x.org/u?a=b")).url);
  for (const bad of ["no scheme", "/relative", ""]) { try { new Request(bad); out.push("ok:" + bad); } catch (e) { out.push(names(e)); } }
  try { new Request("http://user:pw@example.com/"); out.push("ok"); } catch (e) { out.push(names(e)); }
  for (const m of ["get", "Post", "delete", "PATCH", "PuT", "options"]) out.push(new Request("http://x/", { method: m, body: m.toLowerCase() === "get" ? undefined : "b" }).method);
  for (const m of ["CONNECT", "a b", "TRACE"]) { try { new Request("http://x/", { method: m }); out.push("ok:" + m); } catch (e) { out.push(names(e)); } }
  for (const m of ["GET", "HEAD", "get"]) { try { new Request("http://x/", { method: m, body: "x" }); out.push("ok:" + m); } catch (e) { out.push(names(e)); } }
  // bodies and content types
  const p = new Request("http://x/", { method: "POST", body: "payload", headers: { "X-H": "1" } });
  out.push(p.headers.get("content-type"), p.headers.get("x-h"), p.body !== null, p.bodyUsed, await p.text(), p.bodyUsed);
  try { await p.json(); out.push("ok"); } catch (e) { out.push(names(e)); }
  const pj = new Request("http://x/", { method: "PUT", body: JSON.stringify({ n: 1 }), headers: { "content-type": "application/json" } });
  out.push(pj.headers.get("content-type"), await pj.json());
  const pb = new Request("http://x/", { method: "POST", body: new Uint8Array([72, 73]) }); out.push(pb.headers.get("content-type"), await pb.text());
  const pn = new Request("http://x/", { method: "POST", body: null }); out.push(pn.body, await pn.text());
  // from another Request: copied, then overridden
  const base = new Request("http://x/base", { method: "POST", body: "bb", headers: { "x-a": "1" }, cache: "no-store", redirect: "manual", keepalive: true, referrer: "http://x/ref" });
  const d1 = new Request(base); out.push(d1.url, d1.method, d1.headers.get("x-a"), d1.cache, d1.redirect, d1.keepalive, d1.referrer, d1.bodyUsed, base.bodyUsed);
  // base's body now feeds d1: another construction from base, or a read of base, is a TypeError;
  // reading d1 marks base used as well
  try { new Request(base, { method: "PUT", headers: { "x-b": "2" } }); out.push("ok"); } catch (e) { out.push(names(e)); }
  try { await base.text(); out.push("ok"); } catch (e) { out.push(names(e)); }
  out.push(base.bodyUsed, await d1.text(), d1.bodyUsed, base.bodyUsed);
  const b2 = new Request("http://x/", { method: "POST", body: "own" }); const d3 = new Request(b2, { body: "init", method: "PUT" }); out.push(d3.method, await d3.text(), b2.bodyUsed, await b2.text());
  const g1 = new Request("http://x/g"); const g2 = new Request(g1, { headers: { "x-b": "2" } }); out.push(g2.headers.get("x-b"), g2.body, await g1.text(), await g2.text());
  const rb = new Response("rb"); const rb2 = new Response(rb.body, rb); out.push(rb.bodyUsed, await rb2.text(), rb.bodyUsed); try { await rb.text(); out.push("ok"); } catch (e) { out.push(names(e)); }
  const used = new Request("http://x/", { method: "POST", body: "u" }); await used.text();
  try { new Request(used); out.push("ok"); } catch (e) { out.push(names(e)); }
  // clone
  const c1 = new Request("http://x/c", { method: "POST", body: "clone" }); const c2 = c1.clone();
  out.push(await c2.text(), c1.bodyUsed, await c1.text(), c2.url);
  // the signal
  // (Node's Request.signal is a fresh signal following the init's; garnet's is the init's signal itself: not compared)
  const ac = new AbortController(); const rs = new Request("http://x/", { signal: ac.signal }); out.push(rs.signal.aborted, typeof r.signal.aborted);
  // formData
  const fu = new Request("http://x/", { method: "POST", body: "a=1&b=x+y&a=2", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const fd = await fu.formData(); out.push(fd.get("a"), fd.getAll("a"), fd.get("b"), fd.has("c"), [...fd.keys()]);
  const boundary = "----b0undary";
  const mp = `--${boundary}\r\nContent-Disposition: form-data; name="f1"\r\n\r\nv1\r\n--${boundary}\r\nContent-Disposition: form-data; name="f2"\r\n\r\nline1\r\nline2\r\n--${boundary}--\r\n`;
  const fm = new Request("http://x/", { method: "POST", body: mp, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
  const fdm = await fm.formData(); out.push(fdm.get("f1"), fdm.get("f2"), [...fdm].length);
  try { await new Request("http://x/", { method: "POST", body: "x" }).formData(); out.push("ok"); } catch (e) { out.push(names(e)); }
  out.push(Object.prototype.toString.call(r), r instanceof Request);
  console.log(JSON.stringify(out));
}
main();
