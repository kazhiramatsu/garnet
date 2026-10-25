// node:stream: Readable (paused and flowing modes, read(n), setEncoding,
// object mode), Writable (backpressure, drain, finish, write after end),
// Transform and PassThrough, pipe, pipeline (callback and promise forms,
// a generator stage), finished, Readable.from, async iteration, destroy.
import { Readable, Writable, Transform, PassThrough, pipeline, finished, Duplex } from "node:stream";
import { pipeline as pipelinePromise, finished as finishedPromise } from "node:stream/promises";
import { Buffer } from "node:buffer";
type Coded = Error & { code: string };
const log: string[] = [];
function counter(n: number, objectMode = false): Readable {
  let i = 0;
  return new Readable({
    objectMode,
    read(): void {
      i++;
      if (i > n) this.push(null);
      else this.push(objectMode ? { i } : String(i));
    },
  });
}
function sink(name: string, hwm = 16384, slow = false): Writable & { chunks: string[] } {
  const w = new Writable({
    highWaterMark: hwm,
    write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
      (w as Writable & { chunks: string[] }).chunks.push(chunk.toString());
      if (slow) setImmediate(callback);   // a write that completes later: the writes queue and backpressure shows
      else callback();
    },
    final(callback: (error?: Error | null) => void): void { log.push(name + ":final"); callback(); },
  }) as Writable & { chunks: string[] };
  w.chunks = [];
  return w;
}
async function flowing(): Promise<void> {
  const r = counter(3);
  const got: string[] = [];
  r.on("data", (c: Buffer) => got.push(c.toString()));
  log.push("flowing:" + r.readableFlowing);
  await new Promise<void>((resolve) => { r.on("end", () => { log.push("end " + got.join(",") + " " + r.readableEnded); }); r.on("close", () => { log.push("close"); resolve(); }); });
}
async function paused(): Promise<void> {
  const r = counter(5);
  r.setEncoding("utf8");
  const got: string[] = [];
  await new Promise<void>((resolve) => {
    r.on("readable", () => {
      let chunk: string | null;
      while ((chunk = r.read(2) as string | null) !== null) got.push(chunk);
    });
    r.on("end", () => { log.push("paused " + got.join("|") + " " + r.readableFlowing); resolve(); });
  });
}
async function objects(): Promise<void> {
  const r = counter(3, true);
  const got: number[] = [];
  for await (const o of r) got.push((o as { i: number }).i);
  log.push("objects " + got.join(",") + " " + r.destroyed);
}
async function backpressure(): Promise<void> {
  const w = sink("bp", 4, true);
  const results: boolean[] = [];
  results.push(w.write("ab"));
  results.push(w.write("cd"));
  results.push(w.write("ef"));
  log.push("needDrain " + w.writableNeedDrain + " len " + w.writableLength);
  await new Promise<void>((resolve) => w.once("drain", resolve));
  log.push("drain " + results.join(",") + " " + w.chunks.join(""));
  await new Promise<void>((resolve) => { w.end("gh", () => { log.push("end-cb " + w.writableFinished + " " + w.chunks.join("")); resolve(); }); });
  w.write("late", (err) => { log.push("late " + (err as Coded).code); });
  await new Promise<void>((resolve) => w.once("error", (err: Coded) => { log.push("error " + err.code + " " + w.destroyed); resolve(); }));
}
async function transformPipe(): Promise<void> {
  const upper = new Transform({
    transform(chunk: Buffer, _enc: string, callback: (error?: Error | null, data?: unknown) => void): void { callback(null, chunk.toString().toUpperCase()); },
    flush(callback: (error?: Error | null, data?: unknown) => void): void { callback(null, "!"); },
  });
  const w = sink("tp");
  const src = Readable.from(["a", "b", "c"]);
  src.pipe(upper).pipe(w);
  await new Promise<void>((resolve) => w.on("finish", resolve));
  log.push("pipe " + w.chunks.join("") + " " + upper.readableEnded + " " + src.readableEnded);
}
async function pipelines(): Promise<void> {
  const w = sink("pl");
  await new Promise<void>((resolve) => {
    pipeline(counter(4), new PassThrough(), w, (err) => { log.push("pipeline " + (err === null || err === undefined) + " " + w.chunks.join("")); resolve(); });
  });
  const w2 = sink("pl2");
  await pipelinePromise(Readable.from(["x", "y"]), async function* (source: AsyncIterable<Buffer | string>) {
    for await (const chunk of source) yield chunk.toString() + chunk.toString();
  }, w2);
  log.push("pipeline-promise " + w2.chunks.join(","));
  const failing = new Writable({ write(_c: Buffer, _e: string, cb: (error?: Error | null) => void): void { cb(new Error("sink failed")); } });
  const src = counter(10);
  try {
    await pipelinePromise(src, failing);
    log.push("no error?");
  } catch (e) {
    log.push("pipeline-error " + (e as Error).message + " " + src.destroyed + " " + failing.destroyed);
  }
}
async function finishedAndDestroy(): Promise<void> {
  const r = counter(2);
  r.resume();
  await finishedPromise(r);
  log.push("finished " + r.readableEnded);
  const d = new PassThrough();
  const events: string[] = [];
  d.on("error", (e: Error) => events.push("error:" + e.message));
  d.on("close", () => events.push("close"));
  d.destroy(new Error("boom"));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  log.push("destroy " + events.join(",") + " " + d.destroyed + " " + d.errored!.message);
  const early = new PassThrough();
  const closed = new Promise<string>((resolve) => finished(early, (err) => resolve(err ? (err as Coded).code : "ok")));
  early.destroy();
  log.push("premature " + (await closed));
}
async function duplexAndRead(): Promise<void> {
  const chunks: string[] = [];
  const d = new Duplex({
    read(): void { this.push("r1"); this.push(null); },
    write(chunk: Buffer, _e: string, cb: (error?: Error | null) => void): void { chunks.push(chunk.toString()); cb(); },
  });
  d.write("w1");
  d.end();
  const readSide = await d.toArray();
  log.push("duplex " + chunks.join(",") + " " + readSide.map((b: Buffer) => b.toString()).join(","));
  const r = new Readable({ read(): void {} });
  r.push("hello ");
  r.push("world");
  r.push(null);
  const all: Buffer | null = await new Promise((resolve) => r.once("readable", () => resolve(r.read() as Buffer)));
  log.push("read-all " + (all === null ? "null" : all.toString()) + " " + r.readableLength);
  const fromString = Readable.from("just a string");
  log.push("from-string " + (await fromString.toArray()).join("|"));
  const empty = Readable.from([]);
  log.push("from-empty " + (await empty.toArray()).length);
  const bad = new Readable({ read(): void {} });
  bad.push(null);
  bad.on("error", (e: Coded) => log.push("push-after-eof " + e.code));
  bad.push("x");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
async function main(): Promise<void> {
  await flowing();
  await paused();
  await objects();
  await backpressure();
  await transformPipe();
  await pipelines();
  await finishedAndDestroy();
  await duplexAndRead();
  console.log(log.join("\n"));
}
main();
