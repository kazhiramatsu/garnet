// tsc cache-key pattern: string keys built from numbers (getTypeListId's
// `result += id` loop, getRelationKey's `${a},${b}${postFix}` template,
// getFlowCacheKey's `${x}|${y}|${z}`), then Map lookups and inserts keyed by
// the fresh strings. V8 builds these with cached number strings and cons
// strings and hashes once at the lookup.
interface Ty { id: number; }
function getTypeListId(types: readonly Ty[]): string {
  let result = "";
  const length = types.length;
  let i = 0;
  while (i < length) {
    const startId = types[i].id;
    let count = 1;
    while (i + count < length && types[i + count].id === startId + count) count++;
    if (result.length) result += ",";
    result += startId;
    if (count > 1) result += ":" + count;
    i += count;
  }
  return result;
}
function getRelationKey(source: Ty, target: Ty, state: number): string {
  const postFix = state ? ":" + state : "";
  return `${source.id},${target.id}${postFix}`;
}
function getFlowCacheKey(container: number, declared: number, initial: number): string {
  return `${container ? container : "-1"}|${declared}|${initial}`;
}
function main(): void {
  const types: Ty[] = [];
  for (let i = 0; i < 4000; i++) types.push({ id: i * 7 + 1 });
  const lists: Ty[][] = [];
  for (let n = 0; n < 500; n++) {
    // mostly short lists, a few long unions (the compiler's SyntaxKind-sized ones)
    const len = n % 25 === 0 ? 40 + (n % 7) * 40 : 1 + (n % 12);
    const list: Ty[] = [];
    for (let k = 0; k < len; k++) list.push(types[(n * 31 + k * 17) % types.length]);
    lists.push(list);
  }
  const unionTypes = new Map<string, Ty>();
  const relation = new Map<string, number>();
  const flowCache = new Map<string, number>();
  let hits = 0, misses = 0, total = 0;
  for (let round = 0; round < 400; round++) {
    for (let n = 0; n < lists.length; n++) {
      const id = getTypeListId(lists[n]);
      total += id.length;
      const cached = unionTypes.get(id);
      if (cached) hits++;
      else { misses++; unionTypes.set(id, lists[n][0]); }
    }
    for (let k = 0; k < 2000; k++) {
      const key = getRelationKey(types[(k * 13) % types.length], types[(k * 29 + round) % types.length], k & 3);
      const r = relation.get(key);
      if (r === undefined) { relation.set(key, k); misses++; } else { hits += r & 1; }
    }
    for (let k = 0; k < 1000; k++) {
      const key = getFlowCacheKey(k % 50, (k * 7) % 300, (k * 3 + round) % 500);
      const v = flowCache.get(key);
      if (v === undefined) flowCache.set(key, k); else hits++;
    }
  }
  console.log(total, hits, misses, unionTypes.size, relation.size, flowCache.size);
}
main();
