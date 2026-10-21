// JSON.stringify of a circular structure throws V8's catchable TypeError
// (the path of open objects and arrays is the test, so a value seen twice
// without a cycle is fine), a deep acyclic structure stringifies, and a Map
// or a Set stringifies as the object it is: its own enumerable properties,
// not its entries.
class Node2 {
  name: string;
  next: Node2 | undefined;
  constructor(name: string) { this.name = name; this.next = undefined; }
}
function tryStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? "undefined"; } catch (e) { return `${(e as Error).constructor.name}: ${(e as Error).message.split("\n")[0].slice(0, 40)}`; }
}
function main(): void {
  const self: Record<string, unknown> = { a: 1 };
  self.me = self;
  console.log(tryStringify(self));
  const x: Record<string, unknown> = { k: "x" }, y: Record<string, unknown> = { k: "y", x };
  x.y = y;
  console.log(tryStringify(x));
  const arr: unknown[] = [1, 2];
  arr.push({ back: arr });
  console.log(tryStringify(arr));
  const n1 = new Node2("n1"), n2 = new Node2("n2");
  n1.next = n2;
  console.log(tryStringify(n1));
  n2.next = n1;
  console.log(tryStringify(n1));
  const shared = { s: 1 };
  console.log(tryStringify({ a: shared, b: shared, c: [shared, shared] }));
  let deep: unknown = 0;
  for (let i = 0; i < 2000; i++) deep = [deep];
  console.log(tryStringify(deep).length);
  const m = new Map<string, number>([["a", 1], ["b", 2]]);
  (m as unknown as Record<string, number>).own = 3;
  const s = new Set([1, 2]);
  console.log(JSON.stringify(m), JSON.stringify(s), JSON.stringify({ m, s, n: new Map() }));
  const inner = { toJSON(): string { return tryStringify(self); } };
  console.log(tryStringify({ inner, after: [1, { ok: true }] }));
  console.log(tryStringify([self]), tryStringify({ fine: 1 }));
}
main();
