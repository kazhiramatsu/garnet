// Array.prototype.sort with a comparator whose result is not an integer: a fraction (`b.q - a.q` over
// quality values, hono's Accept parser), a negative fraction, a boolean, a string, NaN and undefined
// (the spec's SortCompare takes ToNumber and its sign; NaN is 0; a boolean comparator is
// inconsistent, never negative, and its order is the engine's own, so none is tested). The result was truncated to an int
// before its sign was read, so every fractional comparator left the array unsorted (Session 358).
function main(): void {
  const objs = [{ q: 0.5, t: "a" }, { q: 1, t: "b" }, { q: 0.75, t: "c" }, { q: 0.1, t: "d" }];
  console.log(JSON.stringify(objs.slice().sort((a, b) => b.q - a.q)));
  console.log(JSON.stringify(objs.slice().sort((a, b) => a.q - b.q).map((o) => o.t)));
  console.log(JSON.stringify([0.5, 1, 0.25, -0.5, 3].sort((a, b) => b - a)));
  console.log(JSON.stringify([0.5, 1, 0.25].sort((a, b) => (b !== a ? b - a : 0))));
  console.log(JSON.stringify([3, 1, 2].sort((a, b) => String(a - b) as unknown as number)));    // "-2" -> -2
  console.log(JSON.stringify([3, 1, 2].sort(() => NaN)));                                       // NaN -> 0: unchanged
  console.log(JSON.stringify([3, 1, 2].sort(() => undefined as unknown as number)));           // undefined -> NaN -> 0
  console.log(JSON.stringify([0.5, 1, 0.25].toSorted((a, b) => b - a)));
  console.log(JSON.stringify(Array.from(new Float64Array([0.5, 1, 0.25]).sort((a, b) => b - a))));
  console.log(JSON.stringify(["b", "a", "c"].sort((a, b) => (a < b ? -0.5 : a > b ? 0.5 : 0))));
  const stable = [{ k: 1, i: 0 }, { k: 0.5, i: 1 }, { k: 1, i: 2 }, { k: 0.5, i: 3 }];
  console.log(JSON.stringify(stable.sort((a, b) => a.k - b.k).map((o) => o.i)));
}
main();
