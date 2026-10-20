// Property vectors and indexes in the payload heap (docs/gc_v2_design.md §6.1,
// slice G2c): an object's external value vector, its dictionary entry vector
// and its property index are released, without a visit, when a collection
// does not mark them through the object; growth replaces the vector and frees
// the old one; a deletion converts a shaped object to a dictionary.
function bag(n: number, tag: string): any {
  const o: any = {};
  for (let i = 0; i < n; i++) o[tag + i] = i;
  return o;
}
function churn(rounds: number): number {
  let acc = 0;
  for (let i = 0; i < rounds; i++) {
    const o = bag(3 + (i % 20), "c");
    const keys = Object.keys(o);
    acc += keys.length + o["c" + (keys.length - 1)];
  }
  return acc;
}
// long-lived objects that keep growing after they are promoted
const keep: any[] = [];
for (let i = 0; i < 30; i++) keep.push(bag(2, "k" + i + "_"));
let total = 0;
for (let round = 0; round < 50; round++) {
  for (let i = 0; i < keep.length; i++) keep[i]["r" + round] = round * i;
  total += churn(80);
  // deletions turn some into dictionaries (with an index past 8 keys)
  if (round % 7 === 3) for (let i = 0; i < keep.length; i += 3) delete keep[i]["r" + (round - 1)];
}
let sum = 0, nkeys = 0;
for (const o of keep) for (const k in o) { sum += typeof o[k] === "number" ? o[k] : 0; nkeys++; }
console.log(total, keep.length, nkeys, sum);

// a big dictionary whose index is rebuilt as it grows
const dict: Record<string, number> = {};
for (let i = 0; i < 3000; i++) {
  dict["key" + i] = i;
  if (i % 3 === 0) delete dict["key" + (i - 1)];
  if (i % 500 === 0) churn(40);
}
let ds = 0;
for (const k in dict) ds += dict[k];
console.log(Object.keys(dict).length, ds, dict["key2999"], dict["key2"], "key1" in dict);

// class instances that receive extra properties
class Node2 { kind = 0; pos = 0; constructor(k: number) { this.kind = k; } }
const nodes: Node2[] = [];
for (let i = 0; i < 2000; i++) {
  const n: any = new Node2(i);
  if (i % 2) n.extraA = i;
  if (i % 3) n.extraB = "b" + i;
  if (i % 5 === 0) { n.extraC = [i]; n.extraD = { i }; n.extraE = i * 2; n.extraF = -i; }
  nodes.push(n);
  if (i % 250 === 0) churn(30);
}
let ns = 0;
for (const n of nodes as any[]) ns += n.kind + (n.extraA ?? 0) + (n.extraB ? n.extraB.length : 0) + (n.extraC ? n.extraC[0] : 0) + (n.extraD ? n.extraD.i : 0) + (n.extraE ?? 0) + (n.extraF ?? 0);
console.log(ns);
