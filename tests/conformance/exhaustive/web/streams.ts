// WHATWG streams (lib/node/web/streams.ts, docs/web_streams_design.md): a ReadableStream fed by start
// and by pull, readers (read, release, cancel with a reason, the closed promise), errors, tee, async
// iteration, ReadableStream.from, pipeTo into a WritableStream (the sink's write, close, abort, the
// writer's ready and desiredSize), pipeThrough a TransformStream (transform, flush, terminate),
// TextEncoderStream and TextDecoderStream (a code point split across chunks), the queuing
// strategies, and the error messages of a locked stream. Node's own streams are the oracle.
const enc = new TextEncoder();
const dec = new TextDecoder();
async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) { const r = await reader.read(); if (r.done) break; out.push(r.value as T); }
  reader.releaseLock();
  return out;
}
const name = (e: unknown): string => `${(e as Error).name}: ${(e as Error).message}`;
async function main(): Promise<void> {
  const started = new ReadableStream<number>({ start(c) { c.enqueue(1); c.enqueue(2); c.close(); } });
  console.log("start:", await readAll(started), started.locked);
  let n = 0;
  const pulled = new ReadableStream<number>({ pull(c) { n++; if (n > 3) c.close(); else c.enqueue(n * 10); } });
  console.log("pull:", await readAll(pulled));
  const r1 = new ReadableStream<string>({ start(c) { c.enqueue("a"); } });
  const reader = r1.getReader();
  console.log("locked:", r1.locked, await reader.read());
  try { r1.getReader(); } catch (e) { console.log("second reader:", name(e)); }
  try { await r1.cancel(); } catch (e) { console.log("cancel locked:", name(e)); }
  const pending = reader.read();
  reader.releaseLock();
  console.log("released:", r1.locked, await pending.then(() => "resolved", (e) => "rejected " + (e as Error).name));
  const cancelled: unknown[] = [];
  const r2 = new ReadableStream<number>({ start(c) { c.enqueue(1); c.enqueue(2); }, cancel(reason) { cancelled.push(reason); } });
  const rd2 = r2.getReader();
  console.log("before cancel:", await rd2.read());
  await rd2.cancel("enough");
  console.log("after cancel:", await rd2.read(), cancelled, await rd2.closed.then(() => "closed"));
  const errored = new ReadableStream<number>({ start(c) { c.enqueue(1); c.error(new RangeError("boom")); } });
  const rd3 = errored.getReader();
  // an error during start drops the queued chunk: every read rejects with the reason
  console.log("errored:", await rd3.read().then((r) => "value " + String(r.value), (e) => "rejected " + name(e)), await rd3.read().then(() => "value", (e) => "rejected " + name(e)), await rd3.closed.then(() => "closed", (e) => "closed rejected " + (e as Error).name));
  const [t1, t2] = new ReadableStream<number>({ start(c) { c.enqueue(1); c.enqueue(2); c.enqueue(3); c.close(); } }).tee();
  console.log("tee:", await readAll(t1), await readAll(t2));
  const iterated: string[] = [];
  for await (const chunk of new ReadableStream<string>({ start(c) { c.enqueue("x"); c.enqueue("y"); c.close(); } })) iterated.push(chunk);
  console.log("for await:", iterated, await readAll(ReadableStream.from([7, 8, 9])), await readAll(ReadableStream.from((function* () { yield "g1"; yield "g2"; })())));
  const sunk: unknown[] = [];
  const sink = new WritableStream<number>({ write(chunk) { sunk.push(chunk); }, close() { sunk.push("closed"); }, abort(reason) { sunk.push("aborted:" + String(reason)); } });
  const writer = sink.getWriter();
  console.log("desired:", writer.desiredSize);
  const w1 = writer.write(1);
  console.log("desired while writing:", writer.desiredSize);
  await w1; await writer.ready;
  console.log("desired after:", writer.desiredSize, sink.locked);
  await writer.write(2);
  await writer.close();
  console.log("sink:", sunk, await writer.closed.then(() => "closed"));
  try { await writer.write(3); } catch (e) { console.log("write after close:", (e as Error).name); }
  const sunk2: unknown[] = [];
  const sink2 = new WritableStream<number>({ write(chunk) { sunk2.push(chunk); }, abort(reason) { sunk2.push("aborted:" + String(reason)); } });
  const writer2 = sink2.getWriter();
  await writer2.write(1);
  await writer2.abort("stop");
  console.log("abort:", sunk2, await writer2.write(2).then(() => "ok", (e) => "rejected " + String(e)));
  writer2.releaseLock();
  const piped = new WritableStream<number>({ write(chunk) { sunk.push("p" + String(chunk)); } });
  await new ReadableStream<number>({ start(c) { c.enqueue(4); c.enqueue(5); c.close(); } }).pipeTo(piped);
  console.log("pipeTo:", sunk.slice(-2), piped.locked);
  const doubled = new ReadableStream<number>({ start(c) { c.enqueue(1); c.enqueue(2); c.enqueue(3); c.close(); } })
    .pipeThrough(new TransformStream<number, number>({ transform(chunk, c) { c.enqueue(chunk * 2); }, flush(c) { c.enqueue(99); } }));
  console.log("pipeThrough:", await readAll(doubled));
  const identity = new TransformStream<string, string>();
  const idWriter = identity.writable.getWriter();
  const idReader = identity.readable.getReader();
  const firstRead = idReader.read();
  await idWriter.write("one");
  console.log("transform identity:", await firstRead);
  const terminated = new TransformStream<number, number>({ transform(chunk, c) { if (chunk > 1) c.terminate(); else c.enqueue(chunk); } });
  const tw = terminated.writable.getWriter();
  const tReads = readAll(terminated.readable);
  await tw.write(1);
  console.log("terminate:", await tw.write(2).then(() => "ok", (e) => "rejected " + (e as Error).name), await tReads);
  const encoded = await readAll(ReadableStream.from(["ab", "あ", "\ud83d", "\ude00"]).pipeThrough(new TextEncoderStream()));
  console.log("encoder:", encoded.map((u) => Array.from(u).join(".")), new TextEncoderStream().encoding);
  const decoded = await readAll(ReadableStream.from([new Uint8Array([0x61, 0xe3, 0x81]), new Uint8Array([0x82, 0x62]), new Uint8Array([0xf0, 0x9f]), new Uint8Array([0x98, 0x80])]).pipeThrough(new TextDecoderStream()));
  console.log("decoder:", decoded, decoded.join(""), new TextDecoderStream().encoding, new TextDecoderStream("utf-8", { fatal: true }).fatal);
  const bytesStrategy = new ByteLengthQueuingStrategy({ highWaterMark: 1024 });
  const countStrategy = new CountQueuingStrategy({ highWaterMark: 4 });
  console.log("strategies:", bytesStrategy.highWaterMark, bytesStrategy.size(new Uint8Array(10)), countStrategy.highWaterMark, countStrategy.size());
  let desired: (number | null)[] = [];
  const hwm = new ReadableStream<string>({ start(c) { desired.push(c.desiredSize); c.enqueue("a"); desired.push(c.desiredSize); c.enqueue("b"); desired.push(c.desiredSize); c.close(); desired.push(c.desiredSize); } }, { highWaterMark: 3 });
  await readAll(hwm);
  console.log("desiredSize:", desired);
  console.log(String(new ReadableStream()), String(new WritableStream()), String(new TransformStream()), String(dec.decode(enc.encode("ok"))));
}
main();
