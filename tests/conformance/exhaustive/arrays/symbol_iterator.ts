interface Nodes<T> extends ReadonlyArray<T> { pos: number }
function flags(nodes: Nodes<number>): number {
  let result = 0;
  for (const node of nodes) result |= node;
  return result;
}
const nodes = [1, 2, 4] as unknown as Nodes<number>;
console.log(flags(nodes));

const values = [10, 20];
const iterator = values[Symbol.iterator]();
console.log(iterator[Symbol.iterator]() === iterator);
console.log(JSON.stringify(iterator.next()));
values.push(30);
delete values[1];
console.log(JSON.stringify(iterator.next()));
console.log(JSON.stringify(iterator.next()));
console.log(JSON.stringify(iterator.next()));
values.push(40);
console.log(JSON.stringify(iterator.next()));
console.log(Array.from(nodes).join(","));
// Allocate enough ordinary iterator results to exercise automatic collection.
let checksum = 0;
for (let round = 0; round < 30000; round++) checksum += flags(nodes);
console.log(checksum);
