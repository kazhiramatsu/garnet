const set = new Set([1, 2]);
const values = set.keys();
console.log(values.next().value, values[Symbol.iterator]() === values, Array.isArray(values));
set.delete(2);
set.add(3);
console.log(values.next().value, values.next().done);
set.add(4);
console.log(values.next().done);
console.log(Array.from(set.values()).join(","), JSON.stringify(Array.from(set.entries())));
const live = set.values();
console.log(live.next().value);
set.clear();
set.add(9);
console.log(live.next().value, live.next().done);
const compact = new Set<number>();
for (let i = 0; i < 180; i++) compact.add(i);
const iterator = compact.keys();
console.log(iterator.next().value);
for (let i = 0; i < 130; i++) compact.delete(i);
compact.add(0);
const rest = Array.from(iterator);
console.log(rest.length, rest[0], rest[rest.length - 1]);
const added = new Set([1]);
const seen: number[] = [];
for (const value of added) {
  seen.push(value);
  if (value === 1) added.add(2);
}
console.log(seen.join(","), Object.prototype.toString.call(added.keys()));
