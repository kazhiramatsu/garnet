// Lazy frames with calls (docs/frame_elision_design.md, round 2b): a function
// whose calls see no live reference links its frame only around inline-cache
// slow paths, each filling the slots of the locals it must find. The objects
// below have accessor properties (an inline cache never answers those, so
// every read and write takes the slow path) that allocate, so a missing or
// stale slot shows up under TSAOT_GC_YOUNG_THRESHOLD=1.

interface Item {
  v: number;
  tag: string;
}

interface Bag {
  items: Item[];
  readonly count: number;
  readonly first: Item;
}

interface Box {
  value: number;
  log: string[];
}

let churn: unknown[] = [];
function allocate(n: number): void {
  for (let i = 0; i < n; i++) churn.push({ i, s: "c" + i });
  if (churn.length > 500) churn = [];
}

function makeBag(n: number): Bag {
  const items: Item[] = [];
  for (let i = 0; i < n; i++) items.push({ v: i, tag: "t" + i });
  return {
    items,
    get count(): number {
      allocate(8);
      return items.length;
    },
    get first(): Item {
      allocate(8);
      return { v: items[0].v + 100, tag: "first" };
    },
  };
}

function makeBox(): Box {
  let stored = 0;
  const log: string[] = [];
  return {
    log,
    get value(): number {
      return stored;
    },
    set value(n: number) {
      allocate(6);
      stored = n;
      log.push("v" + n);
    },
  };
}

function weigh(it: Item): number {
  let w = it.v * 2;
  for (let i = 0; i < it.tag.length; i++) w += it.tag.charCodeAt(i) & 3;
  return w;
}

// a reference live across accesses only; the call consumes its argument
function summarize(b: Bag, extra: Item): number {
  const n = b.count;
  const items = b.items;
  const head = items[0];
  const firstTag = b.first.tag;
  const len = firstTag.length;
  return n + len + extra.v + weigh(head);
}

// a local dead before a call, a later local in its slot, accesses after
function reuse(b: Bag, k: number): number {
  const a = b.first;
  const av = a.v;
  const w = weigh(a);
  const c = b.first;
  const cv = c.v;
  return av + w + cv + b.count + k;
}

// a loop of accesses and calls; the loop-carried value is a number
function scan(b: Bag): number {
  let total = 0;
  const n = b.items.length;
  for (let i = 0; i < n; i++) {
    const it = b.items[i];
    const c = b.count;
    total += c + weigh(it);
  }
  return total;
}

// fresh objects only this function holds: `t` (a getter's result) is live
// across another getter's slow path whose receiver is `fresh`
function probe(k: number): number {
  const fresh = makeBag(3 + (k % 4));
  const t = fresh.first;
  const n = fresh.count;
  const tl = t.tag.length;
  return n + t.v + tl + fresh.items.length * 1000;
}

// stores through the slow path (a setter that allocates)
function fill(box: Box, items: Item[]): number {
  for (let i = 0; i < items.length; i++) {
    box.value = items[i].v;
  }
  const v = box.value;
  return v + box.log.length;
}

function main(): void {
  const bag = makeBag(12);
  const out: number[] = [];
  for (let round = 0; round < 25; round++) {
    out.push(summarize(bag, { v: round, tag: "x" }));
    out.push(reuse(bag, round));
    out.push(scan(bag));
    out.push(fill(makeBox(), bag.items));
    out.push(probe(round));
  }
  out.push(summarize(makeBag(3), { v: 1, tag: "y" }), reuse(makeBag(4), 2), scan(makeBag(5)));
  let h = 0;
  for (const v of out) h = (h * 31 + v) % 1000003;
  console.log(out.slice(0, 8).join(","), out.length, h);
}
main();
