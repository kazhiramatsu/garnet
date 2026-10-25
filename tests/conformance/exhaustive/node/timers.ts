// The event loop: nextTick before promise reactions, timers by due time then order, intervals,
// immediates after the timers of a turn, unref'd timers not keeping the process alive, the
// Timeout object, timers/promises, beforeExit and exit.
import { setTimeout as sleep, setImmediate as soon, setInterval as every } from "node:timers/promises";
const log: string[] = [];
function tag(s: string): () => void { return () => { log.push(s); }; }
async function main(): Promise<void> {
  process.nextTick(tag("tick1"));
  Promise.resolve().then(tag("micro1"));
  process.nextTick(() => { log.push("tick2"); Promise.resolve().then(tag("micro-from-tick")); process.nextTick(tag("tick-from-tick")); });
  queueMicrotask(tag("micro2"));
  log.push("sync");
  setTimeout(tag("t30"), 30);
  setTimeout(tag("t10a"), 10);
  setTimeout(tag("t10b"), 10);
  const t0 = setTimeout(() => { log.push("t0"); setTimeout(tag("inner-t0"), 0); setImmediate(tag("inner-imm")); }, 0);
  setTimeout((a: number, b: string) => { log.push("args:" + a + b); }, 1, 7, "x");
  const cancelled = setTimeout(tag("cancelled"), 5);
  clearTimeout(cancelled);
  clearTimeout(undefined);
  clearTimeout(Number(cancelled));
  const idle = setTimeout(tag("idle-never"), 60000);
  idle.unref();
  log.push("hasRef:" + idle.hasRef() + ":" + t0.hasRef() + ":" + typeof Number(t0) + ":" + typeof t0.refresh);
  const im = setImmediate(tag("imm-cleared"));
  clearImmediate(im);
  // a main-level immediate races 0/1 ms timers in Node: queue it from a timer instead
  setTimeout(() => { setImmediate((v: string) => { log.push("imm:" + v); }, "arg"); }, 30);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  log.push("after-60");
  // the interval on its own, so its ticks race nothing
  await new Promise<void>((resolve) => { let n = 0; const iv = setInterval(() => { n++; log.push("iv" + n); if (n === 3) { clearInterval(iv); resolve(); } }, 5); });
  const v = await sleep(5, "slept");
  const w = await soon("immediate");
  let ticks = 0;
  for await (const x of every(2, "iv")) { ticks++; if (ticks === 2) break; void x; }
  log.push(v + "," + w + ",intervals:" + ticks);
  let refreshed = 0;
  const r = setTimeout(() => { refreshed++; }, 20);
  await sleep(12);
  r.refresh();
  await sleep(12);
  log.push("refreshed-early:" + refreshed);
  await sleep(15);
  log.push("refreshed-late:" + refreshed);
  let errs = "";
  try { setTimeout("nope" as unknown as () => void); } catch (e) { errs += (e as { code: string }).code; }
  try { process.nextTick(1 as unknown as () => void); } catch (e) { errs += "," + (e as { code: string }).code; }
  log.push(errs);
  let before = 0;
  process.on("beforeExit", () => { before++; if (before === 1) setTimeout(tag("from-beforeExit"), 1); });
  process.on("exit", (code: number) => { log.push("exit:" + code + ":before=" + before); console.log(log.join("\n")); });
  process.exitCode = 0;
}
main();
