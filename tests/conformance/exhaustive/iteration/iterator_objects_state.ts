// Array, Map and Set iterator objects as values: next() by hand, every kind, live arrays, iterators
// frozen or relinked, the iterator prototype's next reached through objects made from it, and
// properties a plain object inherits from its prototype read before and after the prototype changes.
function drain<T>(it: Iterator<T>): string {
  const out: string[] = [];
  for (let r = it.next(); !r.done; r = it.next()) out.push(JSON.stringify(r.value));
  return out.join(" ");
}

function main(): void {
  const arr = [10, 20, 30];
  console.log(drain(arr.values()), "|", drain(arr.keys()), "|", drain(arr.entries()), "|", drain(arr[Symbol.iterator]()));
  // live: elements pushed during the walk are visited, a shortened array ends it
  const live = [1, 2, 3];
  const li = live.values();
  const seen: number[] = [];
  for (let r = li.next(); !r.done; r = li.next()) {
    seen.push(r.value);
    if (r.value === 2) live.push(4);
    if (r.value === 4) live.length = 1;
  }
  console.log(seen.join(","), JSON.stringify(li.next()), JSON.stringify(li.next()));
  // holes read as undefined
  const holes = [1, , 3];
  console.log(drain(holes.values()));
  // a done iterator stays done after the array grows
  const short = [1];
  const si = short.values();
  si.next(); si.next();
  short.push(2);
  console.log(JSON.stringify(si.next()));
  // the result objects are fresh and writable
  const ri = [5, 6].values();
  const r1 = ri.next();
  (r1 as any).value = 99;
  console.log(JSON.stringify(r1), JSON.stringify(ri.next()), r1 === ri.next());
  // a frozen iterator still steps (its state is not its properties)
  const fz = Object.freeze([7, 8].values());
  console.log(drain(fz));
  // no own properties are visible
  const vi = [1].values();
  console.log(Object.keys(vi).length, Object.getOwnPropertyNames(vi).length, JSON.stringify(vi), Object.prototype.toString.call(vi));
  // next through an object made from the iterator's prototype, and next taken as a value
  const proto = Object.getPrototypeOf([].values());
  const made = Object.create(proto);
  console.log(typeof made.next, made.next === [1].values().next);
  let threw = "no";
  try { made.next(); } catch (e) { threw = (e as Error).constructor.name; }
  console.log(threw);
  const nextFn = proto.next;
  console.log(JSON.stringify(nextFn.call([3, 4].values())));
  // many iterators, many steps (the caches stay right across iterators and arrays)
  let sum = 0;
  for (let i = 0; i < 3000; i++) {
    const a = i % 2 ? [i, 1] : [i, 2, 3];
    const it = a.values();
    for (let r = it.next(); !r.done; r = it.next()) sum += r.value;
  }
  console.log(sum);

  // Map and Set iterators
  const m = new Map<string, number>([["a", 1], ["b", 2]]);
  console.log(drain(m.keys()), "|", drain(m.values()), "|", drain(m.entries()));
  const st = new Set<number>([3, 4]);
  console.log(drain(st.values()), "|", drain(st.entries()));
  const mi = m.keys();
  mi.next();
  m.set("c", 3);
  m.delete("b");
  console.log(drain(mi));
  console.log(Object.keys(m.values()).length, Object.prototype.toString.call(st.values()));

  // inherited reads of plain objects: a prototype's method and data, then the prototype changes
  const base: any = { greet() { return "base"; }, n: 1 };
  const objs: any[] = [];
  for (let i = 0; i < 4; i++) { const o = Object.create(base); o.i = i; objs.push(o); }
  const reads = (): string => objs.map((o) => o.greet() + o.n).join(",");
  console.log(reads());
  base.n = 2;
  console.log(reads());
  base.greet = () => "changed";
  console.log(reads());
  Object.defineProperty(base, "n", { get() { return 3; } });
  console.log(reads());
  const other: any = { greet() { return "other"; }, n: 4 };
  Object.setPrototypeOf(objs[1], other);
  console.log(reads());
  Object.defineProperty(objs[2], "n", { value: 5 });
  console.log(reads());
  delete base.greet;
  let gone = "";
  try { objs[0].greet(); } catch (e) { gone = (e as Error).constructor.name; }
  console.log(gone, objs[1].greet());

  // an iterator object in dictionary mode (a deleted property), its `next` not in the first slot
  const dict: any = {
    a: 1, b: 2, n: 0,
    next(this: any) { this.n++; return this.n > 2 ? { done: true, value: undefined } : { done: false, value: this.n }; },
    [Symbol.iterator](this: any) { return this; },
  };
  delete dict.b;
  const dictOut: number[] = [];
  for (const x of dict) dictOut.push(x);
  console.log(dictOut.join(","));
  // a shaped iterator with an own `next`, then another shape, then one with an inherited `next`
  const own = (start: number, extra: boolean): any => {
    const it: any = extra ? { z: 0, n: start } : { n: start };
    it.next = function (this: any) { this.n++; return { done: this.n % 3 === 0, value: this.n }; };
    it[Symbol.iterator] = function (this: any) { return this; };
    return it;
  };
  class CountDown {
    constructor(public n: number) {}
    next() { return { done: this.n <= 0, value: this.n-- }; }
    [Symbol.iterator]() { return this; }
  }
  const ownOut: number[] = [];
  for (const src of [own(0, false), own(3, true), own(6, false), new CountDown(2)]) for (const x of src as any) ownOut.push(x);
  console.log(ownOut.join(","));
  // an array-like whose `length` restructures its own iterator during a step
  const holder: { it?: any } = {};
  const like: any = { 0: "a", 1: "b", get length() { holder.it.x = 1; delete holder.it.x; return 2; } };
  holder.it = Array.prototype.values.call(like);
  console.log(JSON.stringify(holder.it.next()), JSON.stringify(holder.it.next()), JSON.stringify(holder.it.next()), JSON.stringify(holder.it.next()));
}

main();
