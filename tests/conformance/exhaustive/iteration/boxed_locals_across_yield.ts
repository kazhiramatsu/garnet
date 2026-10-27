// Boxed locals of generators and async functions across suspensions, under allocation pressure: strings,
// arrays and objects built between yields (temporaries that die before the yield and values that must
// survive it), a generator that allocates heavily between yields while an outer loop keeps its own
// objects live, nested delegation carrying objects, a try/catch inside a generator with a thrown value
// read in the catch after a yield, and an async function holding objects across awaits.
interface Rec { id: number; tags: string[]; note?: string }
function* records(n: number): Generator<Rec, string, undefined> {
  const made: Rec[] = [];
  let summary = "";
  for (let i = 0; i < n; i++) {
    const tags = ["t" + i, "u" + (i * 2)];           // dies before the yield
    const r: Rec = { id: i, tags, note: i % 2 ? "odd" : undefined };
    made.push(r);
    const filler = new Array(64).fill(0).map((_, k) => "f" + (k + i));   // garbage before the yield
    summary += filler[i % 64].length;
    yield r;                                          // made and summary live across
    r.tags.push("after" + i);                         // r used after the yield: live across
  }
  return summary + ":" + made.map((m) => m.tags.length).join("");
}
function* catcher(): Generator<number, string, undefined> {
  let last = "none";
  for (let i = 0; i < 3; i++) {
    try {
      const obj = { v: i, s: "s" + i };
      if (i === 1) throw new Error("boom" + obj.s);
      yield obj.v;
      last = obj.s;                                   // obj live across the yield
    } catch (e) {
      last = (e as Error).message;                    // read on the exception path
      yield -i;
    }
  }
  return last;
}
function* chain(depth: number): Generator<string, string[], undefined> {
  const seen: string[] = [];
  if (depth > 0) {
    const inner = yield* chain(depth - 1);
    seen.push(...inner);
  }
  const mine = "d" + depth + ":" + new Array(depth + 1).join("x");
  yield mine;
  seen.push(mine);
  return seen;
}
async function operands(): Promise<string> {
  // the receiver, the index and the left operand are evaluated before the await and used after it
  const log: string[] = [];
  const slots: number[] = [0, 0, 0];
  const rec: { a?: number; b?: string } = {};
  let i = 1, s = "s";
  log.push("got:" + (await Promise.resolve(7)));
  slots[i] = await Promise.resolve(42);
  rec.a = await Promise.resolve(3);
  rec.b = s + (await Promise.resolve("!"));
  s += await Promise.resolve("?");
  const m = new Map<string, number>();
  m.set("k" + i, await Promise.resolve(9));
  return log.join(",") + "|" + slots.join(",") + "|" + rec.a + rec.b + "|" + s + "|" + m.get("k1");
}
function* operandsGen(): Generator<number, string, number> {
  const log: string[] = [];
  const arr: number[] = [1, 2, 3];
  let idx = 2;
  log.push("w:" + (yield 1));          // the receiver and the left operand across the yield
  arr[idx] = yield 2;                  // the array and the index across the yield
  const o = { v: 0 };
  o.v = (yield 3) * 2;                 // the object across the yield
  return log.join(",") + "|" + arr.join(",") + "|" + o.v;
}
async function gather(xs: string[]): Promise<string> {
  let acc: string[] = [];
  const held = { count: 0 };
  for (const x of xs) {
    const tmp = x.toUpperCase() + x.length;
    await Promise.resolve();
    acc.push(tmp); held.count++;
    const junk = new Array(1000).fill(x);   // garbage between awaits
    await Promise.resolve(junk.length);
  }
  return acc.join(",") + "/" + held.count;
}
function main(): void {
  const out: string[] = [];
  const keep: Rec[] = [];
  const g = records(200);
  let r = g.next();
  while (!r.done) { keep.push(r.value); if (keep.length % 50 === 0) out.push(keep[keep.length - 1].tags.join("+")); r = g.next(); }
  out.push(String(r.value).slice(0, 40), String(keep.length), String(keep[7].tags.length), String(keep[8].note));
  const c = catcher();
  const cs: number[] = [];
  let cr = c.next();
  while (!cr.done) { cs.push(cr.value); cr = c.next(); }
  out.push(cs.join(","), String(cr.value));
  out.push([...chain(4)].join("|"));
  const og = operandsGen();
  og.next(); og.next(5); og.next(6);
  out.push(String(og.next(7).value));
  gather(["ab", "cde", "f"]).then((v) => operands().then((w) => console.log(out.join("\n") + "\n" + v + "\n" + w)));
}
main();
