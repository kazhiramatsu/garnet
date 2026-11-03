// A comparator that allocates: the sort's elements live in runtime arrays a collection can move.
class Item { constructor(public key: number, public tag: string) {} }
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const r = rng(7);
const items: Item[] = [];
for (let i = 0; i < 4000; i++) items.push(new Item(Math.floor(r() * 500), "t" + i));
let garbage: unknown[] = [];
items.sort((a, b) => {
  garbage.push({ a: a.tag + b.tag, n: [a.key, b.key] });
  if (garbage.length > 64) garbage = [];
  return a.key - b.key;
});
let ok = true;
for (let i = 1; i < items.length; i++) {
  if (items[i - 1].key > items[i].key) ok = false;
  if (items[i - 1].key === items[i].key && +items[i - 1].tag.slice(1) > +items[i].tag.slice(1)) ok = false;
}
console.log(ok, items[0].tag, items[items.length - 1].tag);
const strs: string[] = [];
for (let i = 0; i < 3000; i++) strs.push("s" + Math.floor(r() * 100000));
strs.sort((a, b) => (a + "x" < b + "x" ? -1 : a + "x" > b + "x" ? 1 : 0));
console.log(strs[0], strs[1500], strs[2999]);
const mixed: any[] = [];
for (let i = 0; i < 2000; i++) mixed.push(i % 3 === 0 ? undefined : { toString() { return "k" + (i % 97); } });
mixed.sort();
console.log(String(mixed[0]), String(mixed[1000]), mixed[1999]);
