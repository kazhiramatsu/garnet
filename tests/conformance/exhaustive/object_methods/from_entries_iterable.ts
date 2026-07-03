// Object.fromEntries accepts any iterable of [key, value] pairs — an array, a
// Map, or a generator — not just an array.
function* gen(): Generator<[string, number]> {
  yield ["p", 1];
  yield ["q", 2];
}

function main(): void {
  const m = new Map([["a", 1], ["b", 2]]);
  const o1 = Object.fromEntries(m);
  console.log(o1.a, o1.b);                       // 1 2

  const o2 = Object.fromEntries([["x", 10], ["y", 20]]);
  console.log(o2.x, o2.y);                       // 10 20

  const src = { a: 1, b: 2 };
  const o3 = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, v * 10]));
  console.log(o3.a, o3.b);                       // 10 20

  const o4 = Object.fromEntries(gen());
  console.log(o4.p, o4.q);                       // 1 2
}

main();
