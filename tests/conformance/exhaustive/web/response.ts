// The Response class (docs/web_fetch_api_design.md): the defaults, a string body's content type,
// the status range, the null-body statuses, a Response as the init (hono's form), text / json /
// arrayBuffer / bytes and bodyUsed, a second read's TypeError, clone, the body placeholder moved
// into another Response, Response.json, Response.redirect, Response.error, URLSearchParams and
// bytes bodies, the object's tag.
function names(e: unknown): string { return (e as Error).constructor.name; }
async function main() {
  const out: unknown[] = [];
  const r = new Response("hello");
  out.push(r.status, r.statusText, r.ok, r.type, r.url, r.redirected, r.bodyUsed, r.headers.get("content-type"), r.body !== null);
  out.push(await r.text(), r.bodyUsed);
  try { await r.text(); out.push("ok"); } catch (e) { out.push(names(e)); }
  const e = new Response(); out.push(e.status, e.body, e.bodyUsed, await e.text(), e.bodyUsed, e.headers.get("content-type"));
  const j = new Response(JSON.stringify({ a: [1, 2] }), { status: 201, statusText: "Created", headers: { "content-type": "application/json", "x-h": "1" } });
  out.push(j.status, j.statusText, j.ok, j.headers.get("content-type"), j.headers.get("x-h"), await j.json());
  for (const s of [199, 600, 1.5, -1]) { try { new Response("x", { status: s }); out.push("ok:" + s); } catch (e) { out.push(names(e)); } }
  for (const s of [204, 205, 304]) { try { new Response("x", { status: s }); out.push("ok:" + s); } catch (e) { out.push(names(e) + ":" + s); } }
  out.push(new Response(null, { status: 204 }).status, new Response(undefined, { status: 304 }).body);
  try { new Response("x", { statusText: "bad\nline" }); out.push("ok"); } catch (e) { out.push(names(e)); }
  // a Response as the init (hono passes one), the headers copied
  const base = new Response("b", { status: 202, statusText: "Accepted", headers: { "x-base": "yes" } });
  const derived = new Response("d", base); out.push(derived.status, derived.statusText, derived.headers.get("x-base"), await derived.text(), base.bodyUsed);
  // the body moved through the stream placeholder, as hono's createResponseInstance does
  const src = new Response("moved", { headers: { "x-m": "1" } });
  const moved = new Response(src.body, src); out.push(await moved.text(), moved.headers.get("x-m"), moved.headers.get("content-type"));
  // clone
  const c1 = new Response("clone me", { status: 203 }); const c2 = c1.clone();
  out.push(await c1.text(), await c2.text(), c2.status, c1.bodyUsed, c2.bodyUsed);
  const used = new Response("u"); await used.text(); try { used.clone(); out.push("ok"); } catch (e) { out.push(names(e)); }
  // arrayBuffer and bytes of a string body; a bytes body's text
  const ab = await new Response("héllo").arrayBuffer(); out.push(ab.byteLength, [...new Uint8Array(ab)].slice(0, 3));
  const by = await new Response("xyz").bytes(); out.push(by.length, by[2]);
  const bb = new Response(new Uint8Array([104, 105])); out.push(bb.headers.get("content-type"), await bb.text());
  const ab2 = new ArrayBuffer(3); new Uint8Array(ab2).set([65, 66, 67]); out.push(await new Response(ab2).text());
  // URLSearchParams and an object body
  const sp = new Response(new URLSearchParams({ a: "1", b: "x y" })); out.push(sp.headers.get("content-type"), await sp.text());
  out.push(await new Response({ k: 1 } as any).text(), await new Response(42 as any).text());
  // the statics
  const rj = Response.json({ ok: true }, { status: 207, headers: { "x-j": "1" } });
  out.push(rj.status, rj.headers.get("content-type"), rj.headers.get("x-j"), await rj.json());
  const rj2 = Response.json("s", { headers: { "content-type": "text/custom" } }); out.push(rj2.headers.get("content-type"), await rj2.text());
  const rd = Response.redirect("http://example.com/next?x=1", 301); out.push(rd.status, rd.headers.get("location"), rd.body, rd.ok);
  out.push(Response.redirect("http://example.com/").status);
  for (const s of [200, 300, 400]) { try { Response.redirect("http://example.com/", s); out.push("ok"); } catch (e) { out.push(names(e)); } }
  try { Response.redirect("not a url"); out.push("ok"); } catch (e) { out.push(names(e)); }
  const er = Response.error(); out.push(er.status, er.type, er.ok, er.body, [...er.headers].length);
  out.push(Object.prototype.toString.call(r), r instanceof Response, typeof Response.json);
  try { await new Response("{bad").json(); out.push("ok"); } catch (e) { out.push(names(e)); }
  console.log(JSON.stringify(out));
}
main();
