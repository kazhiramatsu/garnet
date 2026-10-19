// tsc flow-type cache pattern: getTypeOfExpression caches in
// flowTypeCache[getNodeId(node)]; checkExpressionWithContextualType clears
// the cache for a window, so the next cached store recreates it as [] and
// lands at a node id in the millions. A dense representation fills the gap
// on every recreation; V8 switches such an array to dictionary elements.
function main(): void {
  const types: { id: number }[] = [];
  for (let i = 0; i < 64; i++) types.push({ id: i });
  let cache: any[] | undefined;
  let hits = 0, misses = 0;
  for (let window = 0; window < 25000; window++) {
    cache = undefined;
    const base = 3000000 + (window % 97) * 1000;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < 40; k++) {
        const nodeId = base + ((k * 7919) % 4000);
        const c = cache || (cache = []);
        const cached = c[nodeId];
        if (cached) hits += cached.id;
        else { misses++; c[nodeId] = types[k & 63]; }
      }
    }
  }
  console.log(hits, misses);
}
main();
