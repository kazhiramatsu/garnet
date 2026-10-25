// fs.createReadStream / fs.createWriteStream: the open and ready events, the
// pending state, writes before the open, bytesWritten and bytesRead, encoding
// and highWaterMark, start and end, a missing file, a copy through pipe,
// async iteration, close().
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
type Coded = Error & { code: string };
async function main(): Promise<void> {
  const log: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garnet-fss-"));
  const file = path.join(dir, "a.txt");
  const w = fs.createWriteStream(file);
  log.push("created " + w.pending + " " + (w.fd === null) + " " + w.writable + " " + path.basename(w.path as string));
  const ev: string[] = [];
  w.on("open", (fd: number) => ev.push("open:" + typeof fd));
  w.on("ready", () => ev.push("ready"));
  w.on("finish", () => ev.push("finish"));
  w.on("close", () => ev.push("close"));
  for (let i = 0; i < 1000; i++) w.write("line " + i + "\n");
  log.push("buffered " + (w.writableLength > 0) + " " + w.writableNeedDrain);
  await new Promise<void>((resolve) => w.end("last\n", () => resolve()));
  log.push("ended " + ev.join(",") + " " + w.bytesWritten + " " + fs.statSync(file)!.size + " " + w.pending);
  await new Promise<void>((resolve) => { if (w.closed) resolve(); else w.once("close", resolve); });
  log.push("closed " + ev.join(",") + " " + w.closed + " " + w.destroyed);
  const r = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1024 });
  log.push("reader " + r.pending + " " + r.readableHighWaterMark + " " + r.readableEncoding);
  let text = "";
  let chunks = 0;
  r.on("data", (chunk: string) => { text += chunk; chunks++; });
  await new Promise<void>((resolve) => r.on("close", resolve));
  log.push("read " + chunks + " " + text.length + " " + text.split("\n").length + " " + r.bytesRead + " " + r.destroyed + " " + r.pending);
  const part = fs.createReadStream(file, { start: 5, end: 10 });
  log.push("part " + (await part.toArray()).map((b: Buffer) => b.toString()).join("|") + " " + part.bytesRead);
  const tail = fs.createReadStream(file, { start: 8890 });
  log.push("tail " + JSON.stringify((await tail.toArray()).map((b: Buffer) => b.toString()).join("")));
  const missing = fs.createReadStream(path.join(dir, "nope"));
  const missingEvents: string[] = [];
  missing.on("error", (e: Coded) => missingEvents.push("error:" + e.code));
  missing.on("close", () => missingEvents.push("close"));
  await new Promise<void>((resolve) => missing.on("close", resolve));
  log.push("missing " + missingEvents.join(",") + " " + missing.destroyed);
  const copy = path.join(dir, "copy.txt");
  await pipeline(fs.createReadStream(file), fs.createWriteStream(copy));
  log.push("copy " + fs.statSync(copy)!.size + " " + (fs.readFileSync(copy, "utf8") === fs.readFileSync(file, "utf8")));
  const lines: string[] = [];
  const lr = fs.createReadStream(copy, { encoding: "utf8", highWaterMark: 777 });
  let rest = "";
  for await (const chunk of lr) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() as string;
    for (const p of parts) lines.push(p);
  }
  log.push("lines " + lines.length + " " + lines[0] + " " + lines[lines.length - 1] + " " + JSON.stringify(rest));
  const appended = fs.createWriteStream(copy, { flags: "a" });
  appended.write("more\n");
  await new Promise<void>((resolve) => appended.close(() => resolve()));
  log.push("append " + (fs.readFileSync(copy, "utf8") as string).endsWith("last\nmore\n") + " " + appended.bytesWritten + " " + appended.closed);
  const positioned = fs.createWriteStream(copy, { flags: "r+", start: 0 });
  await new Promise<void>((resolve) => positioned.end("LINE", () => resolve()));
  await new Promise<void>((resolve) => positioned.once("close", resolve));
  log.push("positioned " + (fs.readFileSync(copy, "utf8") as string).slice(0, 8));
  try { fs.createReadStream(file, { start: 10, end: 5 }); } catch (e) { log.push("range " + (e as Coded).code + " " + (e as Error).message); }
  const early = fs.createReadStream(file);
  early.close();
  await new Promise<void>((resolve) => early.once("close", resolve));
  log.push("early " + early.destroyed + " " + early.bytesRead);
  fs.rmSync(dir, { recursive: true });
  console.log(log.join("\n"));
}
main();
