// A worker that starts workers of its own, on memory it made. The outer worker creates a
// SharedArrayBuffer, starts inner workers with it as their workerData, and takes items from a cursor
// in it beside them (Atomics.add), each marking the items it took; then it returns to its event loop
// for their messages, and answers the main thread once every inner worker has exited. One inner
// worker throws before it takes anything: the outer worker gets its 'error' and its exit code 1.
// Whoever takes an item, every item is taken once and the sum is the same. Only the main thread prints.
// (Under garnet a worker is a fork, and so is a worker's worker: docs/fork_workers_design.md.)
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

interface Outer { kind: "outer"; items: number; inners: number; failing: number }
interface Inner { kind: "inner"; index: number; board: SharedArrayBuffer; items: number; fails: boolean }
interface Answer { sum: number; taken: number; untaken: number; errors: string[]; exits: number[] }

function value(i: number): number {
  return (i * i + 7 * i + 3) % 1009;
}

/** Takes items from the cursor in board[0] until none is left; board[1 + i] says who took item i. */
function take(board: Int32Array, items: number, who: number): number[] {
  let sum = 0;
  let taken = 0;
  for (;;) {
    const i = Atomics.add(board, 0, 1);
    if (i >= items) break;
    Atomics.store(board, 1 + i, who);
    sum += value(i);
    taken++;
  }
  return [sum, taken];
}

function outer(job: Outer): void {
  const shared = new SharedArrayBuffer(4 * (1 + job.items));
  const board = new Int32Array(shared);
  let sum = 0;
  let taken = 0;
  let running = 0;
  const errors: string[] = [];
  const exits: number[] = [];
  const answer = (): void => {
    let untaken = 0;
    for (let i = 0; i < job.items; i++) if (Atomics.load(board, 1 + i) === 0) untaken++;
    const a: Answer = { sum, taken, untaken, errors: errors.sort(), exits: exits.sort() };
    parentPort!.postMessage(a);
  };
  const exited = (): void => {
    if (--running === 0) answer();
  };
  for (let k = 1; k <= job.inners; k++) {
    const data: Inner = { kind: "inner", index: k, board: shared, items: job.items, fails: k === job.failing };
    const w = new Worker(new URL(import.meta.url), { workerData: data });
    running++;
    w.on("message", (m: number[]) => { sum += m[0]!; taken += m[1]!; });
    w.on("error", (e: Error) => { errors.push(e.message); });
    w.on("exit", (code: number) => { exits.push(code); exited(); });
  }
  // beside its workers, before it returns to the event loop for what they post
  const own = take(board, job.items, 100);
  sum += own[0]!;
  taken += own[1]!;
  if (running === 0) answer();
}

function inner(job: Inner): void {
  if (job.fails) throw new Error("inner " + job.index + " fails");
  parentPort!.postMessage(take(new Int32Array(job.board), job.items, job.index));
}

function start(label: string, job: Outer, next: () => void): void {
  let expected = 0;
  for (let i = 0; i < job.items; i++) expected += value(i);
  const w = new Worker(new URL(import.meta.url), { workerData: job });
  w.on("message", (a: Answer) => {
    console.log(label, "sum", a.sum, a.sum === expected, "taken", a.taken, "untaken", a.untaken);
    console.log(label, "errors", JSON.stringify(a.errors), "exits", JSON.stringify(a.exits));
  });
  w.on("error", (e: Error) => console.log(label, "error", e.message));
  w.on("exit", (code: number) => { console.log(label, "exit", code); next(); });
}

function main(): void {
  start("three", { kind: "outer", items: 300000, inners: 3, failing: 0 }, () =>
    start("one fails", { kind: "outer", items: 300000, inners: 4, failing: 2 }, () =>
      start("none", { kind: "outer", items: 1000, inners: 0, failing: 0 }, () =>
        start("no items", { kind: "outer", items: 0, inners: 2, failing: 1 }, () => console.log("done")))));
}

if (isMainThread) main();
else if ((workerData as Outer | Inner).kind === "outer") outer(workerData as Outer);
else inner(workerData as Inner);
