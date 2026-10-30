// CompressionStream / DecompressionStream (lib/node/web/compression.ts over runtime/zlib_host.c,
// docs/web_compression_design.md): round trips in the three formats (one write, several, none, a
// large body cut into Node's 16 KiB output chunks), the headers zlib writes, the classes' surface and
// the format errors, the chunk types the writable side takes (a string as UTF-8, any view; others
// rejected with Node's errors), pipeThrough from a body, a slow reader holding the writes back, an
// empty stream. The compressed bytes depend on the zlib build: only what any zlib agrees on is
// printed. Node's own streams are the oracle.
const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const nm = (e: unknown): string => `${(e as Error).name} ${(e as { code?: string }).code} ${(e as Error).message}`;
async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = readable.getReader();
  for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); }
  return chunks;
}
function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
async function through(stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }, inputs: Uint8Array[]): Promise<Uint8Array[]> {
  const w = stream.writable.getWriter();
  const p = collect(stream.readable);
  for (const i of inputs) await w.write(i as BufferSource);
  await w.close();
  return p;
}
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
async function main(): Promise<void> {
  const big = new Uint8Array(100000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
  for (const fmt of ["gzip", "deflate", "deflate-raw"] as CompressionFormat[]) {
    const text = enc.encode("hono ".repeat(500));
    const c1 = concat(await through(new CompressionStream(fmt), [text]));
    const d1 = await through(new DecompressionStream(fmt), [c1]);
    console.log(fmt, "header", hex(c1.subarray(0, fmt === "gzip" ? 3 : fmt === "deflate" ? 2 : 0)), "smaller", c1.length < text.length, "back", d1.map((c) => c.length).join(","), same(concat(d1), text));
    const c2 = concat(await through(new CompressionStream(fmt), [enc.encode("abc"), enc.encode("def"), new Uint8Array(0), enc.encode("abc")]));
    console.log("  writes:", new TextDecoder().decode(concat(await through(new DecompressionStream(fmt), [c2]))));
    const c3 = concat(await through(new CompressionStream(fmt), []));
    const d3 = await through(new DecompressionStream(fmt), [c3]);
    console.log("  nothing:", c3.length > 0 || fmt === "deflate-raw", d3.length, concat(d3).length);
    const c4 = concat(await through(new CompressionStream(fmt), [big.subarray(0, 30000), big.subarray(30000)]));
    const d4 = await through(new DecompressionStream(fmt), [c4]);
    console.log("  big:", d4.map((c) => c.length).join(","), same(concat(d4), big));
    // the compressed bytes one at a time: the output still comes cut at 16 KiB
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < c4.length; i += 97) pieces.push(c4.subarray(i, i + 97));
    const d5 = await through(new DecompressionStream(fmt), pieces);
    console.log("  pieces:", d5.length, d5.every((c) => c.length <= 16384), same(concat(d5), big));
  }
  // known vectors
  const vec = (h: string): Uint8Array => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; };
  console.log(new TextDecoder().decode(concat(await through(new DecompressionStream("gzip"), [vec("1f8b08000000000000134b4c4a4e04230018482d4609000000")]))),
    new TextDecoder().decode(concat(await through(new DecompressionStream("deflate"), [vec("789c4b4c4a4e042300113d0373")]))),
    new TextDecoder().decode(concat(await through(new DecompressionStream("deflate-raw"), [vec("4b4c4a4e042300")]))));
  // the classes
  const cs = new CompressionStream("gzip");
  console.log(String(cs), Object.keys(cs), typeof cs.readable, cs.readable instanceof ReadableStream, cs.writable instanceof WritableStream, cs.readable === cs.readable);
  console.log(Object.prototype.toString.call(new DecompressionStream("deflate")), CompressionStream.name, DecompressionStream.name, CompressionStream.length);
  for (const f of ["GZIP", "zstd", "", "x"]) {
    try { new CompressionStream(f as CompressionFormat); console.log(f, "accepted"); } catch (e) { console.log(JSON.stringify(f), nm(e)); }
    try { new DecompressionStream(f as CompressionFormat); console.log(f, "accepted"); } catch (e) { console.log(JSON.stringify(f), nm(e)); }
  }
  try { new CompressionStream(undefined as unknown as CompressionFormat); } catch (e) { console.log("undefined:", nm(e)); }
  console.log("object format:", new DecompressionStream({ toString() { return "gzip"; } } as unknown as CompressionFormat) instanceof DecompressionStream);
  // chunk types
  const chunks: [string, unknown][] = [["string", "abcé"], ["number", 1], ["null", null], ["undefined", undefined], ["object", {}], ["array", [1, 2]],
    ["arraybuffer", new ArrayBuffer(2)], ["float64", new Float64Array([1.5])], ["uint16", new Uint16Array([0x6162])], ["dataview", new DataView(new Uint8Array([97, 98, 99, 100]).buffer, 1, 2)]];
  for (const [label, chunk] of chunks) {
    const c = new CompressionStream("deflate");
    const w = c.writable.getWriter();
    let wr: string;
    try { await w.write(chunk as BufferSource); wr = "write ok"; } catch (e) { wr = "write err " + nm(e); }
    let cl: string;
    try { await w.close(); cl = "close ok"; } catch (e) { cl = "close err " + nm(e); }
    if (wr === "write ok") console.log(label, wr, cl, hex(concat(await through(new DecompressionStream("deflate"), [concat(await collect(c.readable))]))));
    else console.log(label, wr, "|", cl);
  }
  // pipeThrough from a body and back
  const text = "garnet compresses ".repeat(20000);
  const gz = concat(await collect(new Response(text).body!.pipeThrough(new CompressionStream("gzip"))));
  console.log("piped:", gz.length < text.length, (await new Response(new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).text()) === text);
  // a slow reader: the writes wait for it
  const noise = new Uint8Array(1 << 20); let s = 1;
  for (let i = 0; i < noise.length; i++) { s = (s * 1103515245 + 12345) >>> 0; noise[i] = s >>> 24; }
  const c = new CompressionStream("deflate");
  const w = c.writable.getWriter();
  const writes = (async () => { for (let i = 0; i < 16; i++) await w.write(noise.subarray(i * 65536, (i + 1) * 65536)); await w.close(); })();
  const reader = c.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) { const x = await reader.read(); if (x.done) break; parts.push(x.value); await new Promise((r) => setTimeout(r, 0)); }
  await writes;
  const back = concat(await through(new DecompressionStream("deflate"), [concat(parts)]));
  console.log("slow reader:", parts.every((p) => p.length <= 16384), same(back, noise));
  console.log("empty pipe:", (await collect(new Blob([]).stream().pipeThrough(new CompressionStream("deflate-raw")).pipeThrough(new DecompressionStream("deflate-raw")))).length);
}
main();
