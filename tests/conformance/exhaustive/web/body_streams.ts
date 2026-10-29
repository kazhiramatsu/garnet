// Request and Response bodies as streams (lib/node/web/fetch.ts over lib/node/web/streams.ts): a
// Response of a ReadableStream (no content-type, text / bytes / json read it, bodyUsed), `body` of a
// string body (one chunk, the same stream each time, a reader locks it and reading disturbs it,
// text() after a reader is a TypeError), a Request with a stream body (duplex required), clone()
// of each (a tee), a locked or disturbed stream refused as a body, async iteration of a body.
const enc = new TextEncoder();
const chunks = (...parts: string[]): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
const name = (e: unknown): string => `${(e as Error).name}: ${(e as Error).message}`;
async function main(): Promise<void> {
  const res = new Response(chunks("ab", "cd"));
  console.log(res.headers.get("content-type"), res.bodyUsed, res.body !== null, res.body === res.body);
  console.log(await res.text(), res.bodyUsed);
  try { await res.text(); } catch (e) { console.log("twice:", name(e)); }
  const res2 = new Response(chunks("{\"a\":", "1}"), { headers: { "content-type": "application/json" } });
  console.log(JSON.stringify(await res2.json()), (await new Response(chunks("x", "yz")).bytes()).length, (await new Response(chunks("x", "yz")).arrayBuffer()).byteLength);
  const plain = new Response("hello");
  const body = plain.body!;
  console.log(plain.bodyUsed, body.locked, String(body));
  const reader = body.getReader();
  console.log(plain.bodyUsed, body.locked, plain.body === body);
  const first = await reader.read();
  console.log(first.done, Array.from(first.value as Uint8Array), plain.bodyUsed);
  console.log(await reader.read(), plain.bodyUsed);
  try { await plain.text(); } catch (e) { console.log("text after reader:", name(e)); }
  const viaBody = new Response("via body");
  const got: string[] = [];
  for await (const chunk of viaBody.body!) got.push(new TextDecoder().decode(chunk));
  console.log(got, viaBody.bodyUsed);
  try { new Request("http://localhost/", { method: "POST", body: chunks("x") }); } catch (e) { console.log("duplex:", name(e)); }
  const req = new Request("http://localhost/up", { method: "POST", body: chunks("up", "load"), duplex: "half" } as RequestInit);
  console.log(req.headers.get("content-type"), req.bodyUsed, req.body !== null);
  const reqClone = req.clone();
  console.log(await req.text(), await reqClone.text(), req.bodyUsed, reqClone.bodyUsed);
  const streamed = new Response(chunks("clone", "me"));
  const cloned = streamed.clone();
  console.log(await cloned.text(), await streamed.text());
  const locked = chunks("l");
  locked.getReader();
  try { new Response(locked); } catch (e) { console.log("locked body:", name(e)); }
  const disturbed = chunks("d");
  await disturbed.cancel();
  try { new Response(disturbed); } catch (e) { console.log("disturbed body:", name(e)); }
  const empty = new Response(null);
  console.log(empty.body, empty.bodyUsed, await empty.text(), empty.bodyUsed);
  const fromText = new Response("text", { headers: { "content-type": "text/plain" } });
  const tee = fromText.clone();
  console.log(await tee.text(), await fromText.body!.getReader().read().then((r) => new TextDecoder().decode(r.value)));
  const viaRequest = new Request("http://localhost/", { method: "POST", body: "form=1" });
  const rb = viaRequest.body!.getReader();
  console.log(new TextDecoder().decode((await rb.read()).value), (await rb.read()).done, viaRequest.bodyUsed);
  // a Request made from a Request: the input's body proxied and the input used at once (`body: null`
  // in the init keeps it); the init's own body replaces it, and then a used input is no error
  // (hono's body-limit rebuilds the read request over a stream of what it read)
  const source = new Request("http://localhost/", { method: "POST", body: "src" });
  const keep = new Request(source, { body: null });
  console.log(source.bodyUsed, await keep.text());
  const used = new Request("http://localhost/", { method: "POST", body: "old" });
  await used.body!.getReader().read();
  const rebuilt = new Request(used, { body: chunks("re", "built"), duplex: "half" } as RequestInit);
  console.log(await rebuilt.text(), rebuilt.method);
  for (const init of [undefined, { body: null }]) { try { new Request(used, init); } catch (e) { console.log("used input:", name(e)); } }
  const streamed2 = new Request("http://localhost/", { method: "POST", body: chunks("pr", "oxy"), duplex: "half" } as RequestInit);
  const proxied = new Request(streamed2);
  console.log(streamed2.bodyUsed, streamed2.body!.locked, await proxied.text(), streamed2.bodyUsed);
  const ofBody = new Response("hello");
  const ofBody2 = new Response(ofBody.body);
  console.log(ofBody.bodyUsed, await ofBody2.text(), ofBody.bodyUsed, ofBody.body!.locked);
  // the stream `body` hands out for a text body is the one a read goes through: locked after
  // text(), the same object before and after; a Response over another's body (hono's
  // `new Response(res.body, res)`) reads it, clones of it each read it; an empty body has a stream;
  // a cancelled one is disturbed but not locked; a released reader leaves the body readable
  const a = new Response("x");
  const ab = a.body!;
  console.log("read after body:", await a.text(), ab.locked, a.body === ab, a.bodyUsed);
  const b = new Response("y");
  await b.text();
  const bb = b.body!;
  console.log("body after read:", bb.locked, b.bodyUsed);
  try { await bb.getReader().read(); } catch (e) { console.log("  reader of it:", name(e)); }
  const r1 = new Response("abc");
  const r2 = new Response(r1.body, r1);
  const r2c = r2.clone();
  console.log("clone of a body-stream response:", await r2c.text(), await r2.text(), r1.bodyUsed, r1.body!.locked, r2.bodyUsed, r2c.bodyUsed, r2.headers.get("content-type"));
  const e = new Response("");
  console.log("empty:", e.body === null, JSON.stringify(await new Response(e.body).text()), e.bodyUsed);
  const cs = new Response("zz");
  const cst = cs.body!;
  await cst.cancel("no");
  console.log("cancel:", cs.bodyUsed, cst.locked);
  try { await cs.text(); } catch (err) { console.log("  text after cancel:", name(err)); }
  const rl = new Response("t1");
  const rlb = rl.body!;
  rlb.getReader().releaseLock();
  console.log("released:", await rl.text(), rlb.locked, rl.bodyUsed);
  const chain = new Response(new Response(new Response("deep").body).body);
  console.log("chain:", await chain.json().catch((err) => (err as Error).name), await new Response(new Response("[1]").body).json());
  const sseLike = new ReadableStream<Uint8Array>({ async start(c) { c.enqueue(enc.encode("event: a\n")); await new Promise((r) => setTimeout(r, 1)); c.enqueue(enc.encode("data: b\n\n")); c.close(); } });
  console.log(JSON.stringify(await new Response(sseLike, { headers: { "content-type": "text/event-stream" } }).text()));
}
main();
