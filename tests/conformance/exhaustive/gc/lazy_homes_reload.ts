// Lazy frames with register homes (docs/lazy_frames_design.md, round 2): a
// collection-free function keeps its reference locals in C locals and fills
// its frame only around a slow path. A slow path that runs user code (a
// getter, a setter) or allocates (a string element read) can collect and
// move every young object the function holds, so the function must read its
// locals back from the frame after the call.
class Box { v: number; next: Box | null; constructor(v: number) { this.v = v; this.next = null; } }
let junk: number[][] = [];
function churn(): void {
  for (let k = 0; k < 40; k++) junk.push([k, k + 1]);
  if (junk.length > 2048) junk = [];
}

// a static-slot read whose slow path is a getter that detaches both boxes
interface Pair { left: Box | null; right: Box | null; readonly churn: number; tag: number; }
function makePair(i: number): Pair {
  return {
    left: new Box(i),
    right: new Box(i * 2),
    tag: i,
    get churn(): number { this.left = null; this.right = null; churn(); return 1; },
  };
}
function readPair(p: Pair): number {
  const l = p.left;
  const r = p.right;
  const c = p.churn;
  return (l ? l.v : -1) + (r ? r.v : -1) + c + p.tag;
}

// a dynamic read (inline cache on `any`) with fresh arguments held only by
// the caller's frame and this function's homes
function readAny(o: any, a: Box, b: Box): number {
  const k: number = o.churnAny;
  return a.v * 3 + b.v + k;
}

// a returned reference after the slow path
function pickAfter(p: Pair, a: Box, b: Box): Box {
  const c = p.churn;
  return c > 0 ? a : b;
}

// writes: a setter behind a static slot and behind the inline cache
interface Sink { value: number; count: number; }
function makeSink(): Sink {
  let seen = 0;
  return {
    get value(): number { return seen; },
    set value(v: number) { churn(); seen = v; },
    count: 0,
  };
}
function writeStatic(s: Sink, a: Box, b: Box): number {
  s.value = a.v;
  s.count = b.v;
  return a.v + b.v + s.count;
}
function writeAny(s: any, a: Box, b: Box): number {
  s.value = b.v;
  return a.v - b.v;
}

// a home reassigned in a loop, with a getter on some links
interface Link { val: number; readonly heavy: number; next: Link | null; }
function makeChain(n: number): Link | null {
  let head: Link | null = null;
  for (let i = 0; i < n; i++) {
    const v = i;
    const node: Link = (i % 3 === 0)
      ? { val: v, get heavy(): number { churn(); return v; }, next: head }
      : { val: v, heavy: 0, next: head };
    head = node;
  }
  return head;
}
function walk(n: Link | null): number {
  let s = 0;
  while (n) { s += n.val + n.heavy; n = n.next; }
  return s;
}

// an element read on a string reached through an array type
function charAfter(xs: any[], i: number, a: Box): number {
  const c = xs[i];
  return (c === "x" ? 100 : 1) + a.v;
}

function main(): void {
  let sum = 0;
  for (let i = 0; i < 2000; i++) sum += readPair(makePair(i));
  console.log("readPair", sum);

  const holder: any = { get churnAny(): number { churn(); return 7; } };
  sum = 0;
  for (let i = 0; i < 2000; i++) sum += readAny(holder, new Box(i), new Box(i + 1));
  console.log("readAny", sum);

  sum = 0;
  for (let i = 0; i < 2000; i++) {
    const got = pickAfter(makePair(i), new Box(i), new Box(-i));
    churn();
    sum += got.v;
  }
  console.log("pickAfter", sum);

  const sink = makeSink();
  const anySink: any = makeSink();
  sum = 0;
  for (let i = 0; i < 2000; i++) {
    sum += writeStatic(sink, new Box(i), new Box(2 * i));
    sum += writeAny(anySink, new Box(i), new Box(1));
  }
  console.log("writes", sum, sink.value, sink.count, anySink.value);

  sum = 0;
  for (let r = 0; r < 20; r++) sum += walk(makeChain(300));
  console.log("walk", sum);

  const text: any[] = ("abxdex" as any) as any[];
  sum = 0;
  for (let i = 0; i < 3000; i++) sum += charAfter(text, i % 6, new Box(i));
  console.log("charAfter", sum, junk.length >= 0);
}
main();
