import { Base, Leaf, Mid, Deep, makeFresh } from "./nodes";
function kindName(x: unknown): string {
  if (x instanceof Leaf) return "leaf";
  if (x instanceof Deep) return "deep";
  if (x instanceof Mid) return "mid";
  if (x instanceof Base) return "base";
  return "other";
}
const items: unknown[] = [new Leaf(), new Mid(), new Deep(), makeFresh().v, {}, null, 5, "s",
  Object.create(Leaf.prototype), Object.create(Object.create(Mid.prototype))];
console.log(items.map(kindName).join(","));
const f1 = makeFresh(), f2 = makeFresh();
console.log(f1.v instanceof f1.cls, f1.v instanceof f2.cls, f2.v instanceof Base);
const leaf = new Leaf(), deep = new Deep();
console.log(Object.getPrototypeOf(leaf) === Leaf.prototype, leaf.constructor === Leaf, Leaf.prototype.constructor === Leaf,
  Object.getPrototypeOf(Deep.prototype) === Mid.prototype, leaf.label(), deep.label(), (items[8] as Leaf).label === leaf.label);
let count = 0;
for (let i = 0; i < 1000; i++) for (const it of items) if (it instanceof Mid) count++;
console.log(count);
