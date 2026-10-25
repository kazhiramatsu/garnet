// node:events: EventEmitter's ordering, once, removal, the unhandled 'error', the notifications, once().
import { EventEmitter, once } from "node:events";
import EE from "node:events";
class Thing extends EventEmitter { name = "thing"; }
function attempt(f: () => unknown): string {
  try { return String(f()); } catch (e) { return (e as Error).constructor.name + ":" + (e as { code?: string }).code + ":" + (e as Error).message; }
}
async function main(): Promise<void> {
  const out: string[] = [];
  const e = new Thing();
  const seen: string[] = [];
  const a = (x: number, y: number): void => { seen.push("a" + (x + y)); };
  const b = (x: number): void => { seen.push("b" + x); };
  e.on("x", a); e.once("x", b); e.prependListener("x", (x: number) => { seen.push("p" + x); });
  out.push([e.emit("x", 1, 2), e.emit("x", 3, 4), e.emit("y"), seen.join(","), e.listenerCount("x"), e.listeners("x").length, e.eventNames().join(",")].join("|"));
  e.on("x", a);
  e.removeListener("x", a);
  out.push([e.listenerCount("x"), e.listenerCount("x", a), e.off("x", a) === e, e.listenerCount("x"), e.listenerCount("x", a)].join("|"));
  const notes: string[] = [];
  e.on("newListener", (name: string) => { notes.push("new:" + String(name)); });
  e.on("removeListener", (name: string) => { notes.push("rm:" + String(name)); });
  e.once("z", () => { notes.push("z!"); });
  e.emit("z"); e.emit("z");
  e.removeAllListeners("x");
  out.push([notes.join(","), e.listenerCount("z"), e.listenerCount("x")].join("|"));
  out.push([attempt(() => e.emit("error", new RangeError("boom"))), attempt(() => e.emit("error", "str")), attempt(() => e.emit("error", { code: 7 }))].join("|"));
  e.on("error", (err: Error) => { notes.push("handled:" + err.message); });
  out.push([e.emit("error", new Error("ok")), notes[notes.length - 1], e.getMaxListeners(), EventEmitter.defaultMaxListeners, e.setMaxListeners(20).getMaxListeners(), e instanceof EE].join("|"));
  const p = once(e, "ready");
  e.emit("ready", 1, "two");
  const args = await p;
  out.push([args.length, args.join("+"), e.listenerCount("ready"), e.listenerCount("error")].join("|"));
  const plain = new EE();
  out.push([plain.emit("nothing"), plain.eventNames().length, plain.rawListeners("q").length, attempt(() => plain.on("q", 1 as unknown as () => void))].join("|"));
  console.log(out.join("\n"));
}
main();
