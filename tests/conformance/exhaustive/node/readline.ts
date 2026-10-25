// node:readline: lines from a stream (LF, CRLF and CR endings, chunks split
// anywhere, the last unterminated line), question and prompt over an output,
// write() as input, pause/resume/close events, async iteration, the promise
// form, and the cursor functions.
import * as readline from "node:readline";
import { createInterface as createPromiseInterface, Readline } from "node:readline/promises";
import { Readable, PassThrough } from "node:stream";
async function main(): Promise<void> {
  const log: string[] = [];
  const lines: string[] = [];
  const rl = readline.createInterface({ input: Readable.from(["a\nb", "\nc\r\nd\r", "\ne", "f"]), crlfDelay: Infinity });
  rl.on("line", (line) => lines.push(line));
  await new Promise<void>((resolve) => rl.on("close", resolve));
  log.push("lines " + lines.join("|") + " " + rl.closed + " " + rl.terminal);
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c: Buffer) => { written += c.toString(); });
  const q = readline.createInterface({ input, output, prompt: "? " });
  const answers: string[] = [];
  q.on("line", (line) => answers.push("line:" + line));
  const answered = new Promise<string>((resolve) => q.question("name: ", (answer) => resolve(answer)));
  input.write("garnet\nnext\n");
  log.push("question " + (await answered) + " " + answers.join(",") + " " + JSON.stringify(written) + " " + q.getPrompt());
  q.setPrompt(">> ");
  q.prompt();
  q.write("typed\n");
  log.push("prompt " + JSON.stringify(written) + " " + answers.join(","));
  const events: string[] = [];
  q.on("pause", () => events.push("pause"));
  q.on("resume", () => events.push("resume"));
  q.on("close", () => events.push("close"));
  q.pause();
  q.resume();
  q.close();
  q.close();
  log.push("events " + events.join(",") + " " + q.closed);
  try { q.prompt(); } catch (e) { log.push("after-close " + (e as Error & { code: string }).code); }
  const iter = readline.createInterface({ input: Readable.from(["x\ny\n", "z"]) });
  const collected: string[] = [];
  for await (const line of iter) collected.push(line);
  log.push("iterate " + collected.join(",") + " " + iter.closed);
  const breaker = readline.createInterface({ input: Readable.from(["1\n2\n3\n"]) });
  for await (const line of breaker) { collected.push(line); if (line === "2") break; }
  log.push("break " + collected.join(",") + " " + breaker.closed);
  const pinput = new PassThrough();
  const prl = createPromiseInterface({ input: pinput, output: new PassThrough() });
  const pending = prl.question("color? ");
  pinput.write("red\n");
  log.push("promise " + (await pending));
  prl.close();
  const seqs = new PassThrough();
  let esc = "";
  seqs.on("data", (c: Buffer) => { esc += c.toString(); });
  readline.cursorTo(seqs, 3);
  readline.cursorTo(seqs, 1, 2);
  readline.moveCursor(seqs, -2, 1);
  readline.clearLine(seqs, 0);
  readline.clearScreenDown(seqs);
  const batch = new Readline(seqs);
  batch.cursorTo(0, 0).clearLine(1);
  await batch.commit();
  log.push("sequences " + JSON.stringify(esc));
  const hist = readline.createInterface({ input: Readable.from(["one\ntwo\ntwo\n"]), terminal: true, historySize: 10 });
  const hlines: string[] = [];
  hist.on("line", (l) => hlines.push(l));
  await new Promise<void>((resolve) => hist.on("close", resolve));
  log.push("history " + hlines.join(",") + " " + hist.history.join(","));
  console.log(log.join("\n"));
}
main();
