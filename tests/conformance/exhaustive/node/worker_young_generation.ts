// node:worker_threads resourceLimits.maxYoungGenerationSizeMb: under Node the size of V8's young
// generation in the worker's isolate; under garnet the forked worker's young budget, the allocation
// between two of its young collections (a worker whose heap ends with it can run without one). The
// option changes when a worker collects, never what it computes: each worker here builds and drops
// structures far past the default budget and answers a checksum, with a large budget, a small one,
// a fractional one, none, and limits garnet has no counterpart for. A resourceLimits that is not an
// object is ignored, as Node ignores it. Only the main thread prints.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

interface Job { rounds: number; keep: number }

function churn(job: Job): number {
  // lists that die at once, and a ring of the last `keep` of them that survives a while
  const ring: number[][] = [];
  let sum = 0;
  for (let r = 0; r < job.rounds; r++) {
    const list: number[] = [];
    for (let i = 0; i < 64; i++) list.push(r * 31 + i);
    const text = "r" + r + ":" + list.length;
    const table = new Map<string, number[]>();
    table.set(text, list);
    sum = (sum + table.get(text)![r % 64]! + text.length) % 1000003;
    ring[r % job.keep] = list;
  }
  for (const list of ring) sum = (sum + list[0]!) % 1000003;
  return sum;
}

function start(label: string, limits: object | undefined, next: () => void): void {
  const job: Job = { rounds: 40000, keep: 500 };
  const w = limits === undefined
    ? new Worker(new URL(import.meta.url), { workerData: job })
    : new Worker(new URL(import.meta.url), { workerData: job, resourceLimits: limits });
  w.on("message", (sum: number) => console.log(label, sum));
  w.on("error", (e: Error) => console.log(label, "error", e.message));
  w.on("exit", (code: number) => { console.log(label, "exit", code); next(); });
}

function main(): void {
  console.log("here", churn({ rounds: 40000, keep: 500 }));
  start("default", undefined, () =>
    start("large", { maxYoungGenerationSizeMb: 256 }, () =>
      start("small", { maxYoungGenerationSizeMb: 1 }, () =>
        start("fraction", { maxYoungGenerationSizeMb: 2.5 }, () =>
          start("others", { maxOldGenerationSizeMb: 512, stackSizeMb: 8 }, () => {
            for (const bad of [5, "x", true]) {
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                new Worker(new URL(import.meta.url), { workerData: { rounds: 1, keep: 1 }, resourceLimits: bad as any });
                console.log("accepted", typeof bad);
              } catch (e) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                console.log("rejected", typeof bad, (e as any).name, (e as any).code);
              }
            }
          })))));
}

if (isMainThread) main();
else parentPort!.postMessage(churn(workerData as Job));
