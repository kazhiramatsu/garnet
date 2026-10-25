// Iterator closing and iterable destructuring. for-of, for-await and yield* call
// the iterator's return() when the loop ends early (break, throw, a return from
// the function) and not when the iterator finishes; an array pattern takes its
// elements from any iterable by the protocol (a hole takes one too) and closes
// an iterator it leaves unfinished; an assignment pattern does the same.
const log: string[] = [];
class Counter {
  constructor(private readonly n: number, private readonly tag: string) {}
  [Symbol.iterator](): Iterator<number> {
    let i = 0;
    return {
      next: (): IteratorResult<number> => (i < this.n ? { value: ++i, done: false } : { value: undefined as unknown as number, done: true }),
      return: (): IteratorResult<number> => { log.push("close:" + this.tag); return { value: undefined as unknown as number, done: true }; },
    };
  }
}
class Plain {
  [Symbol.iterator]() {
    let i = 0;
    return { next(): IteratorResult<number> { i++; return i > 3 ? { value: undefined as unknown as number, done: true } : { value: i, done: false }; } };
  }
}
function* gen(tag: string): Generator<number> {
  try { yield 1; yield 2; yield 3; } finally { log.push("fin:" + tag); }
}
function asyncSource(tag: string) {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<number>> { i++; return Promise.resolve(i > 3 ? { value: undefined as unknown as number, done: true } : { value: i, done: false }); },
        return(): Promise<IteratorResult<number>> { log.push("aclose:" + tag); return Promise.resolve({ value: undefined as unknown as number, done: true }); },
      };
    },
  };
}
async function* agen(tag: string): AsyncGenerator<number> {
  try { yield 1; yield 2; yield 3; } finally { log.push("afin:" + tag); }
}
function* over(src: Iterable<number>): Generator<number> { yield* src; }
function firstOver(src: Iterable<number>): number {
  for (const v of src) { if (v === 1) return v * 100; }
  return -1;
}
async function firstAsync(): Promise<number> {
  for await (const v of asyncSource("ret")) { if (v === 2) return v * 10; }
  return -1;
}
async function main(): Promise<void> {
  // for-of
  for (const v of new Counter(3, "break")) { if (v === 2) break; }
  for (const v of new Counter(3, "end")) { log.push("v" + v); }
  for (const v of new Counter(3, "continue")) { if (v === 1) continue; log.push("c" + v); }
  try { for (const v of new Counter(3, "throw")) { if (v === 1) throw new Error("boom"); } } catch (e) { log.push((e as Error).message); }
  log.push("first:" + firstOver(new Counter(3, "return")));
  for (const v of new Plain()) { if (v === 1) break; }
  log.push("plain-done");
  for (const v of gen("break")) { if (v === 2) break; }
  // for-await: a sync iterable, an async-iterable object, an async generator
  for await (const v of new Counter(3, "await-break")) { if (v === 1) break; }
  for await (const v of asyncSource("break")) { if (v === 2) break; }
  for await (const v of asyncSource("end")) { log.push("a" + v); }
  try { for await (const v of asyncSource("throw")) { if (v === 1) throw new Error("aboom"); } } catch (e) { log.push((e as Error).message); }
  log.push("afirst:" + (await firstAsync()));
  for await (const v of agen("break")) { if (v === 1) break; }
  // yield*: the outer loop's break closes the inner iterator through the delegation
  for (const v of over(new Counter(5, "delegate"))) { if (v === 2) break; }
  for (const v of over(gen("delegate"))) { if (v === 1) break; }
  const o = over(gen("manual"));
  log.push("o:" + o.next().value);
  log.push("o:" + o.return(7).value + ":" + o.next().done);
  const whole: number[] = [];
  for (const v of over(new Counter(2, "whole"))) whole.push(v);
  log.push("whole:" + whole.join(","));
  // destructuring from iterables
  const [s1, s2] = new Set([10, 20]);
  const m = new Map<string, number>([["x", 1], ["y", 2]]);
  const [[k, v]] = m;
  const [k1, k2] = m.keys();
  const [g1] = gen("destructure");
  const [c1, ...crest] = new Counter(4, "rest");
  const [p1, , p3] = new Counter(5, "hole");
  const [d1 = 7, d2 = 8, d3 = 9] = new Counter(2, "defaults");
  const [e1, e2] = new Plain();
  const [t1, t2] = "ab";
  const [n1, [n2, n3]] = [1, new Counter(2, "nested")];
  log.push([s1, s2, k, v, k1, k2, g1, c1, crest.join("/"), p1, p3, d1, d2, d3, e1, e2, t1, t2, n1, n2, n3].join(" "));
  let a = 0, b = 0, c = 0, rest: number[] = [];
  const result = [a, b = 99, ...rest] = new Counter(1, "assign");
  log.push([a, b, rest.length, result instanceof Counter].join(" "));
  [a, , c] = new Counter(5, "assign-hole");
  log.push([a, c].join(" "));
  [a, b] = new Set([5, 6]);
  log.push([a, b, ...new Counter(2, "spread")].join(" "));
  console.log(log.join("|"));
}
main();
