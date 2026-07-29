// Four receiver layouts cycle through the same two dynamic access sites. This
// keeps the benchmark on the polymorphic object path instead of a typed-struct
// or scalar-replacement fast path.
const objects: any[] = [
  { x: 1, y: 2 },
  { pad: 0, x: 3, y: 4 },
  { x: 5, pad: 0, y: 6 },
  { a: 0, b: 0, x: 7, y: 8 },
];

function readPair(value: any): number {
  return value.x + value.y;
}

let total = 0;
for (let i = 0; i < 20_000_000; i++) {
  total += readPair(objects[i & 3]);
}
console.log(total);
