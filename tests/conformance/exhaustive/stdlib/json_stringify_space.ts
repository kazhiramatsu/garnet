function main(): void {
  // Pretty-print with a numeric indent.
  console.log(JSON.stringify({ a: 1, b: 2 }, null, 2));
  // a:
  // {
  //   "a": 1,
  //   "b": 2
  // }

  // Nested objects and arrays.
  console.log(JSON.stringify({ a: 1, b: { c: [1, 2] } }, null, 2));

  // Top-level array.
  console.log(JSON.stringify([1, 2, 3], null, 2));

  // String indent unit (a tab).
  console.log(JSON.stringify({ x: 1, y: 2 }, null, "\t"));

  // Empty object / array stay on one line.
  console.log(JSON.stringify({}, null, 2));
  console.log(JSON.stringify([], null, 4));

  // undefined replacer behaves like null.
  console.log(JSON.stringify({ a: 1 }, undefined, 2));

  // Deeper nesting with a larger indent.
  console.log(JSON.stringify({ list: [{ n: 1 }, { n: 2 }] }, null, 4));

  // Compact form (no space) is unchanged.
  console.log(JSON.stringify({ a: 1, b: [2, 3] }));
}
main();
