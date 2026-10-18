const map = new Map([["a", 1], ["b", 2]]);
const keys = map.keys();
console.log(keys.next().value, keys[Symbol.iterator]() === keys, Array.isArray(keys));
map.delete("b");
map.set("c", 3);
console.log(keys.next().value, keys.next().done);
map.set("d", 4);
console.log(keys.next().done);
console.log(Array.from(map.values()).join(","), JSON.stringify(Array.from(map.entries())));
const live = map.values();
console.log(live.next().value);
map.clear();
map.set("after", 9);
console.log(live.next().value, live.next().done);
const compact = new Map<number, number>();
for (let i = 0; i < 180; i++) compact.set(i, i);
const iterator = compact.keys();
console.log(iterator.next().value);
for (let i = 0; i < 130; i++) compact.delete(i);
compact.set(0, 200);
const rest = Array.from(iterator);
console.log(rest.length, rest[0], rest[rest.length - 1]);
const added = new Map([[1, 1]]);
const seen: number[] = [];
for (const [key, value] of added) {
  seen.push(key + value);
  if (key === 1) added.set(2, 3);
}
console.log(seen.join(","), Object.prototype.toString.call(added.keys()));
