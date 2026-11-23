// Workers started together. Under garnet a worker constructed with `start: false` is not forked by its
// constructor: `Worker.startTogether` starts the ones it is given through one fork of this process (which
// forks them and waits for them), so their parent is back after one fork however many they are. Node
// ignores the option and has no such function: it starts each worker where it is constructed, and
// `Worker.startTogether?.()` does nothing there. What the program sees is the same: every worker has its
// workerData, gets the messages posted to it before it ran, and answers; one throws (its 'error', then
// 'exit' with 1), one exits with a code of
// its own, one is terminated while it waits, one is never given work and ends when its port is closed.
// A second batch is shared workers that publish what they return, and a batch of one. Only the main
// thread prints, in an order that does not depend on which worker is first.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { publish } from "garnet:shared";

interface Job { kind: "sum" | "throws" | "exits" | "waits" | "idle" | "publishes"; index: number; from: number; to: number }
interface Answer { index: number; sum: number; seen: number[] }
class Result { constructor(public index: number, public values: number[], public label: string) {} }

function sum(from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (i * i) % 7;
  return s;
}

function work(job: Job): void {
  const port = parentPort!;
  if (job.kind === "throws") throw new Error("worker " + job.index + " throws");
  if (job.kind === "exits") process.exit(3);
  if (job.kind === "publishes") {
    port.postMessage(publish(new Result(job.index, [sum(job.from, job.to), job.to - job.from], "published")));
    return;
  }
  if (job.kind === "idle") {
    // nothing to do: it ends when its port is closed
    port.on("message", (m: number) => { if (m === 0) port.close(); });
    return;
  }
  const seen: number[] = [];
  port.on("message", (m: number) => {
    if (m === 0) {
      if (job.kind === "waits") return;   // stays until it is terminated
      const answer: Answer = { index: job.index, sum: sum(job.from, job.to), seen };
      port.postMessage(answer);
      port.close();
    } else seen.push(m);
  });
}

function main(): void {
  const lines: string[] = [];
  let running = 0;
  const done = (): void => {
    if (--running > 0) return;
    lines.sort();
    for (const line of lines) console.log(line);
    second();
  };
  const kinds: Job["kind"][] = ["sum", "sum", "throws", "sum", "exits", "waits", "sum", "idle"];
  const workers: Worker[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const job: Job = { kind: kinds[i]!, index: i, from: i * 1000, to: i * 1000 + 5000 };
    const options = { workerData: job, start: false };
    const w = new Worker(new URL(import.meta.url), options);
    running++;
    w.on("message", (a: Answer) => lines.push(`a ${a.index} sum ${a.sum} seen ${a.seen.join(",")}`));
    w.on("error", (e: Error) => lines.push(`e ${i} ${e.message}`));
    w.on("exit", (code: number) => { lines.push(`x ${i} exit ${code}`); done(); });
    // posted before the worker runs
    w.postMessage(10 + i);
    w.postMessage(20 + i);
    workers.push(w);
  }
  Worker.startTogether?.(workers);
  for (const w of workers) w.postMessage(0);   // the work goes out once they run
  setTimeout(() => { void workers[5]!.terminate(); }, 50);
}

function second(): void {
  // shared workers started together: each publishes its result, which arrives by reference
  const lines: string[] = [];
  let running = 0;
  const workers: Worker[] = [];
  for (let i = 0; i < 4; i++) {
    const job: Job = { kind: "publishes", index: i, from: i, to: i + 3000 };
    const options = { workerData: job, start: false, shared: true };
    const w = new Worker(new URL(import.meta.url), options);
    running++;
    w.on("message", (r: Result) => lines.push(`p ${r.index} ${r.values.join(",")} ${r.label}`));
    w.on("exit", (code: number) => {
      lines.push(`x ${i} exit ${code}`);
      if (--running > 0) return;
      lines.sort();
      for (const line of lines) console.log(line);
      third();
    });
    workers.push(w);
  }
  Worker.startTogether?.(workers);
  // starting them again does nothing
  Worker.startTogether?.(workers);
}

function third(): void {
  // one worker, and none
  const job: Job = { kind: "sum", index: 0, from: 0, to: 100 };
  const options = { workerData: job, start: false };
  const w = new Worker(new URL(import.meta.url), options);
  w.on("message", (a: Answer) => console.log(`one: sum ${a.sum} seen ${a.seen.length}`));
  w.on("exit", (code: number) => console.log("one: exit", code));
  Worker.startTogether?.([]);
  Worker.startTogether?.([w]);
  w.postMessage(0);
}

if (isMainThread) main();
else work(workerData as Job);
