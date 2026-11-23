// garnet:arena in shared workers (docs/arena_design.md): a worker builds a tree in an arena and publishes it.
// Under garnet the tree is handed to the parent without being walked (the arena's cells are published when
// it ends); under Node the arena is a call and the publish freezes and the post copies. What the program sees
// is the same: the parent reads the tree the worker built, the worker cannot write it after the publish, a
// worker goes on to further arenas (nested ones among them, and garbage made inside), and what a worker makes
// outside an arena is its own as always. Only the main thread prints, in an order of its own.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { arena } from "garnet:arena";
import { publish } from "garnet:shared";

class Item {
  constructor(
    public kind: number,
    public text: string,
    public children: Item[],
    public parent: Item | undefined,
  ) {}
}
class Tree {
  constructor(
    public root: Item,
    public names: Map<string, Item>,
    public kinds: Set<number>,
    public count: number,
    public options: { strict: boolean; tags: string[] },
  ) {}
}
interface Job { seed: number; size: number }
class Result {
  constructor(
    public seed: number,
    public tree: Tree,
    public own: string,
    public frozen: string,
  ) {}
}

function build(seed: number, size: number): Tree {
  const names = new Map<string, Item>();
  const kinds = new Set<number>();
  const root = new Item(0, "root" + seed, [], undefined);
  let at = root;
  let count = 1;
  for (let i = 1; i < size; i++) {
    const scratch = [i, seed, "t" + i];   // garbage made inside the arena
    const item = new Item(i % 7, "n" + ((seed * 31 + i) % 97) + (scratch.length === 3 ? "" : "?"), [], at);
    at.children.push(item);
    names.set(item.text, item);
    kinds.add(item.kind);
    count++;
    if (i % 5 === 0) at = item;
    else if (i % 11 === 0 && at.parent !== undefined) at = at.parent;
  }
  return new Tree(root, names, kinds, count, { strict: seed % 2 === 0, tags: ["a" + seed, "b"] });
}
function measure(tree: Tree): string {
  let sum = 0;
  let deepest = 0;
  let texts = 0;
  const stack: [Item, number][] = [[tree.root, 0]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop()!;
    sum += item.kind;
    texts += item.text.length;
    if (depth > deepest) deepest = depth;
    for (const child of item.children) {
      if (child.parent !== item) sum += 1000000;
      stack.push([child, depth + 1]);
    }
  }
  return [tree.count, sum, deepest, texts, tree.names.size, tree.kinds.size, tree.options.strict, tree.options.tags.join("")].join(" ");
}

function work(): void {
  const port = parentPort!;
  const mine: number[] = [];   // the worker's own, made outside any arena and written throughout
  port.on("message", (job: Job | null) => {
    if (job === null) {
      port.postMessage(mine.join(","));
      port.close();
      return;
    }
    mine.push(job.seed);
    const tree = arena(() => {
      const first = build(job.seed, job.size);
      // an arena inside the arena, and a tree that is dropped
      const second = arena(() => build(job.seed + 1, 20));
      return second.count === 20 ? first : second;
    });
    const own = measure(tree);
    publish(tree);
    let frozen = String(Object.isFrozen(tree)) + String(Object.isFrozen(tree.root)) + String(Object.isFrozen(tree.root.children));
    try {
      tree.count = -1;
      frozen += " written";
    } catch (e) {
      frozen += " " + (e instanceof TypeError ? "TypeError" : "other");
    }
    try {
      tree.names.set("x", tree.root);
      frozen += " set";
    } catch (e) {
      frozen += " " + (e instanceof TypeError ? "TypeError" : "other");
    }
    port.postMessage(publish(new Result(job.seed, tree, own, frozen)));
    mine.push(-job.seed);
  });
}

function main(): void {
  const lines: string[] = [];
  let running = 0;
  for (let w = 0; w < 3; w++) {
    const options = { shared: true };
    const worker = new Worker(new URL(import.meta.url), options);
    running++;
    worker.on("message", (m: Result | string) => {
      if (typeof m === "string") lines.push(`w${w} own ${m}`);
      else lines.push(`w${w} seed ${m.seed}: ${measure(m.tree) === m.own ? "same" : "DIFFERS"} ${m.own} | ${m.frozen}`);
    });
    worker.on("error", (e: Error) => lines.push(`w${w} error ${e.message}`));
    worker.on("exit", (code: number) => {
      lines.push(`w${w} exit ${code}`);
      if (--running > 0) return;
      lines.sort();
      for (const line of lines) console.log(line);
    });
    for (const size of [5, 3000, 40, 5200, 700]) worker.postMessage({ seed: w * 10 + (size % 9), size });
    worker.postMessage(null);
  }
}

if (isMainThread) main();
else work();
