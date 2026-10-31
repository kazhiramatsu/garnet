// The iteration protocol where the types do not settle it, and GetIterator's record: an iterator's
// `next` is read once when a loop or a pattern starts, an array pattern over an `any` or a string goes
// through the protocol (a Set, a Map, a generator, code points, a TypeError for what is not iterable),
// and a real array there is still read by index.
function selfReplacing(log: string[]): any {
  return {
    n: 0,
    next(this: any) {
      this.n++;
      log.push("next " + this.n);
      this.next = function () { log.push("replacement"); return { done: true, value: undefined }; };
      return this.n > 3 ? { done: true, value: undefined } : { done: false, value: this.n };
    },
    [Symbol.iterator](this: any) { return this; },
  };
}
class SelfReplacing {
  n = 0;
  next(): IteratorResult<number> {
    this.n++;
    (this as any).next = function () { return { done: true, value: undefined }; };
    return this.n > 3 ? { done: true, value: undefined } : { done: false, value: this.n };
  }
  [Symbol.iterator]() { return this; }
}
interface Stepper { next(): IteratorResult<number>; [Symbol.iterator](): Stepper }
function stepperOf(): Stepper { return new SelfReplacing(); }

function* numbers(): Generator<number> {
  try { yield 1; yield 2; yield 3; } finally { closeLog.push("generator finally"); }
}
const closeLog: string[] = [];
function closing(): any {
  return {
    n: 0,
    next(this: any) { this.n++; return { done: this.n > 5, value: this.n }; },
    return(this: any) { closeLog.push("return at " + this.n); return {}; },
    [Symbol.iterator](this: any) { return this; },
  };
}

function bindParam([a, b]: any): string { return a + ":" + b; }
function bindNested({ pair: [a, b] }: any, [[c], d]: any): string { return [a, b, c, d].join(":"); }
function bindDefault([a = "da", b = "db", ...rest]: any): string { return a + ":" + b + ":" + rest.length; }

function attempt(f: () => unknown): string {
  try { return String(f()); } catch (e) { return (e as Error).constructor.name; }
}

function main(): void {
  // `next` once, every driver
  let log: string[] = [];
  const out: number[] = [];
  for (const x of selfReplacing(log)) out.push(x);
  console.log(out.join(","), log.join(","));
  const out2: number[] = [];
  for (const x of new SelfReplacing()) out2.push(x);
  console.log(out2.join(","));
  const out3: number[] = [];
  for (const x of stepperOf()) out3.push(x);
  console.log(out3.join(","));
  log = [];
  const [p, q, r, s] = selfReplacing(log);
  console.log(p, q, r, s, log.join(","));
  console.log([...selfReplacing([])].join(","), Array.from(selfReplacing([]) as Iterable<number>).join(","));

  // a `next` read at the start: a getter runs once, and a later replacement on the prototype is not seen
  let reads = 0;
  const getter: any = {
    n: 0,
    get next() { reads++; const self = this; return () => { self.n++; return { done: self.n > 2, value: self.n }; }; },
    [Symbol.iterator](this: any) { return this; },
  };
  const got: number[] = [];
  for (const x of getter) got.push(x);
  console.log(got.join(","), reads);

  // array patterns over values an `any` holds
  const set: any = new Set([1, 2, 3]);
  const [s1, s2] = set;
  const map: any = new Map([["k", 1], ["l", 2]]);
  const [[k1, v1], [k2]] = map;
  const gen: any = numbers();
  const [g1, g2] = gen;
  console.log(s1, s2, k1, v1, k2, g1, g2, closeLog.join(","));
  closeLog.length = 0;
  const [c1, c2] = closing();
  console.log(c1, c2, closeLog.join(","));
  closeLog.length = 0;
  const [e1, e2, e3, e4, e5, e6] = closing();
  console.log(e1, e5, e6, closeLog.join(","));
  const [, , third] = new Set([7, 8, 9]) as any;
  const [first, ...others] = new Set([7, 8, 9]) as any;
  console.log(third, first, others.join(","));
  let a1: unknown, b1: unknown;
  [a1, b1] = set;
  console.log(a1, b1);
  const typedArr: any = new Uint8Array([5, 6]);
  const [t1, t2] = typedArr;
  console.log(t1, t2);

  // parameters, nested patterns, defaults, for..of variables
  console.log(bindParam(new Set([1, 2])), bindParam([3, 4]), bindParam("xy"), bindParam(numbers()));
  console.log(bindNested({ pair: new Set([1, 2]) }, [new Set([3]), 4]));
  console.log(bindDefault(new Set<string>()), bindDefault(new Set(["x"])), bindDefault(["p", "q", "r", "s"]));
  const rows: any[] = [new Set([1, 2]), [3, 4], "ab", new Map([[5, 6]])];
  for (const [x, y] of rows) console.log(x, y);

  // a real array through an `any`, holes, sparse, length changes, and a Proxy of one
  const arr: any = [1, , 3];
  const [h1, h2, h3, h4] = arr;
  console.log(h1, h2, h3, h4);
  const [only, ...restOfArr] = [1, 2, 3] as any;
  console.log(only, restOfArr.join(","), Array.isArray(restOfArr));
  const trace: string[] = [];
  const px: any = new Proxy([1, 2], { get(t, key, r) { trace.push(String(key)); return Reflect.get(t, key, r); } });
  const [px1, px2] = px;
  console.log(px1, px2, trace.join(","));
  const [own]: any = { 0: "not used", length: 1, [Symbol.iterator]() { return [9][Symbol.iterator](); } };
  console.log(own);

  // strings iterate by code points
  const smile = "😀b";
  const [sm1, sm2] = smile;
  console.log(sm1, sm2, sm1.length);
  const anyStr: any = "😀c";
  const [sm3, sm4] = anyStr;
  console.log(sm3, sm4, sm3.length);
  const [lone, ...restStr] = "a😀b" as string;
  console.log(lone, restStr.join("|"));
  const maybe: string | string[] = Math.random() < 2 ? "😀d" : ["x"];
  const [mb1, mb2] = maybe;
  console.log(mb1, mb2);

  // what is not iterable is a TypeError at the pattern or the loop
  console.log(attempt(() => { const [x] = {} as any; return x; }));
  console.log(attempt(() => { const [x] = { 0: "a", length: 1 } as any; return x; }));
  console.log(attempt(() => { const [x] = 5 as any; return x; }));
  console.log(attempt(() => { const [x] = true as any; return x; }));
  console.log(attempt(() => { const [x] = null as any; return x; }));
  console.log(attempt(() => { const [x] = undefined as any; return x; }));
  console.log(attempt(() => { for (const x of {} as any) return x; return "none"; }));
  console.log(attempt(() => { for (const x of { next() { return { done: true, value: 0 }; } } as any) return x; return "none"; }));
  console.log(attempt(() => { const o: any = { [Symbol.iterator]: 5 }; for (const x of o) return x; return "none"; }));
  console.log(attempt(() => { const o: any = { [Symbol.iterator]() { return 5; } }; const [x] = o; return x; }));
  console.log(attempt(() => { const o: any = { [Symbol.iterator]() { return {}; } }; const [x] = o; return x; }));

  // many steps: the caches of the old lookup are gone, the loops still step every kind
  let sum = 0;
  const sources: any[] = [[1, 2, 3], new Set([4, 5]), new Map([[6, 7]]).keys(), numbers(), "ab", new SelfReplacing()];
  for (let i = 0; i < 300; i++) {
    const src = i % 6 === 3 ? numbers() : i % 6 === 5 ? new SelfReplacing() : i % 6 === 2 ? new Map([[6, 7]]).keys() : sources[i % 6];
    for (const x of src) sum += typeof x === "number" ? x : (x as string).length;
    const [z] = i % 6 === 2 ? new Set([1]) as any : src;
    sum += z === undefined ? 0 : 1;
  }
  console.log(sum);
}

main();
