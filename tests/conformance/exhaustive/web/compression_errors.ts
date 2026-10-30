// DecompressionStream's failures (docs/web_compression_design.md), Node's own as the oracle: a zlib
// failure is a TypeError carrying the zlib error (its message, errno and code) as its cause and its
// code; data after a gzip or deflate stream's end is ERR_TRAILING_JUNK_AFTER_STREAM_END (a gzip
// stream's further members are read, zero bytes after one are junk; a deflate-raw stream ends its
// readable side there); a stream that ends early is "unexpected end of file". The writes resolve and
// the close fails with the failure until it lands (the next turn of the loop: Node's zlib runs on its
// thread pool), later writes fail with it and a close refuses with ERR_INVALID_STATE; an abort errors
// the readable side with its reason, a cancel the writable side.
const enc = new TextEncoder();
const vec = (h: string): Uint8Array => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; };
const cat = (...p: Uint8Array[]): Uint8Array => { let n = 0; for (const x of p) n += x.length; const o = new Uint8Array(n); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
const describe = (e: unknown): string => {
  const x = e as Error & { code?: string; cause?: Error & { errno?: number; code?: string } };
  const c = x.cause;
  return `${x.name} code=${x.code} msg=${JSON.stringify(x.message)} keys=${Object.keys(x).join(",")}` + (c ? ` cause=[${c.message} ${c.code} ${c.errno} keys=${Object.keys(c).join(",")}]` : "");
};
async function run(fmt: CompressionFormat, inputs: unknown[], label: string): Promise<void> {
  const ds = new DecompressionStream(fmt);
  const w = ds.writable.getWriter();
  const writes: string[] = [];
  let read = "";
  const reading = (async () => {
    const reader = ds.readable.getReader();
    const sizes: number[] = []; let text = "";
    try {
      for (;;) { const r = await reader.read(); if (r.done) break; sizes.push(r.value.byteLength); text += new TextDecoder().decode(r.value); }
      read = `read ok [${sizes.join(",")}] ${JSON.stringify(text.slice(0, 24))}`;
    } catch (e) { read = `read err ${describe(e)} after [${sizes.join(",")}]`; }
  })();
  for (const input of inputs) {
    try { await w.write(input as BufferSource); writes.push("ok"); } catch (e) { writes.push("err " + describe(e)); }
  }
  let closed: string;
  try { await w.close(); closed = "close ok"; } catch (e) { closed = "close err " + describe(e); }
  await reading;
  console.log(label);
  console.log("  writes:", writes.join(" | "));
  console.log("  " + closed);
  console.log("  " + read);
}
const nm = (e: unknown): string => `${(e as Error).name} ${(e as { code?: string }).code}`;
async function attempt(label: string, p: Promise<unknown>): Promise<void> {
  try { await p; console.log(label, "ok"); } catch (e) { console.log(label, nm(e)); }
}
async function main(): Promise<void> {
  const gz = vec("1f8b08000000000000134b4c4a4e04230018482d4609000000");
  const df = vec("789c4b4c4a4e042300113d0373");
  const raw = vec("4b4c4a4e042300");
  await run("gzip", [gz], "gzip ok");
  await run("gzip", [gz.subarray(0, 5), gz.subarray(5)], "gzip split");
  await run("gzip", [gz.subarray(0, 12)], "gzip truncated");
  await run("gzip", [cat(gz, enc.encode("xyz"))], "gzip junk");
  await run("gzip", [gz, enc.encode("xyz")], "gzip junk later");
  await run("gzip", [cat(gz, new Uint8Array(2))], "gzip zero pad");
  await run("gzip", [cat(gz, gz)], "gzip two members");
  await run("gzip", [gz, gz], "gzip members apart");
  await run("gzip", [cat(gz, gz.subarray(0, 4))], "gzip partial member");
  await run("gzip", [enc.encode("hello world")], "gzip garbage");
  await run("gzip", [], "gzip nothing");
  await run("gzip", [vec("1f8b08000000000000134b4c4a4e04230018482d4709000000")], "gzip bad crc");
  await run("gzip", [vec("1f8b08000000000000134b4c4a4e04230018482d460a000000")], "gzip bad length");
  await run("deflate", [df], "deflate ok");
  await run("deflate", [cat(df, new Uint8Array([1]))], "deflate junk");
  await run("deflate", [df, new Uint8Array([0])], "deflate junk later");
  await run("deflate", [vec("789c4b4c4a4e042300113d0374")], "deflate bad sum");
  await run("deflate", [vec("78da")], "deflate header only");
  await run("deflate", [new Uint8Array(0)], "deflate empty chunk");
  await run("deflate", [gz], "deflate given gzip");
  await run("gzip", [df], "gzip given deflate");
  await run("deflate-raw", [raw], "raw ok");
  await run("deflate-raw", [raw.subarray(0, 5)], "raw truncated");
  await run("deflate-raw", [cat(raw, vec("0000"))], "raw trailing");
  await run("deflate-raw", [raw, enc.encode("later")], "raw trailing later");
  await run("deflate-raw", [vec("ff")], "raw invalid");
  await run("deflate-raw", [], "raw nothing");
  await run("gzip", ["abc"], "gzip string chunk");
  await run("deflate", [new DataView(df.buffer, df.byteOffset, df.byteLength)], "deflate DataView");
  // when the failure lands
  {
    const ds = new DecompressionStream("deflate");
    const w = ds.writable.getWriter();
    const read = ds.readable.getReader().read();
    await attempt("write:", w.write(enc.encode("hello")));
    await attempt("read:", read);
    await new Promise((res) => setTimeout(res, 20));
    await attempt("late write:", w.write(new Uint8Array(1)));
    await attempt("late close:", w.close());
    await attempt("closed:", w.closed);
  }
  {
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter();
    await attempt("w1:", w.write(enc.encode("garbage")));
    await attempt("w2:", w.write(new Uint8Array(3)));
    await attempt("close:", w.close());
    await attempt("read:", ds.readable.getReader().read());
  }
  try { await new Response(new Response("not gzip data at all").body!.pipeThrough(new DecompressionStream("gzip"))).text(); }
  catch (e) { console.log("piped:", nm(e), ((e as Error).cause as Error).message); }
  // an abort errors the readable side with its reason
  {
    const c = new CompressionStream("gzip");
    const w = c.writable.getWriter();
    const r = c.readable.getReader();
    await w.write(new Uint8Array(10));
    await w.abort(new Error("stop"));
    const log: string[] = [];
    try { for (;;) { const x = await r.read(); log.push(x.done ? "done" : "chunk " + x.value.byteLength); if (x.done) break; } } catch (e) { log.push("read err " + (e as Error).message); }
    console.log("abort:", log.join(" | "));
  }
  // a cancel errors the writable side with its reason
  {
    const c = new CompressionStream("gzip");
    const w = c.writable.getWriter();
    const r = c.readable.getReader();
    await w.write(new Uint8Array(10));
    await r.cancel("bye");
    try { await w.write(new Uint8Array(1)); console.log("write after cancel ok"); } catch (e) { console.log("write after cancel:", String(e)); }
  }
}
main();
