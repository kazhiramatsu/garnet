// tsc cache-key pattern: type ids joined into a string key (getTypeListId), a
// two-id template key (getRelationKey) and Map<string, T> lookups with them.
function getTypeListId(ids: number[]): string {
  let result = "";
  let i = 0;
  while (i < ids.length) {
    const startId = ids[i];
    let count = 1;
    while (i + count < ids.length && ids[i + count] === startId + count) count++;
    if (result.length) result += ",";
    result += startId;
    if (count > 1) result += ":" + count;
    i += count;
  }
  return result;
}
function relationKey(a: number, b: number, state: number): string { const postFix = state ? ":" + state : ""; return `${a},${b}${postFix}`; }
function main(): void {
  const lists: number[][] = [];
  for (let i = 0; i < 512; i++) { const n = 1 + (i % 5); const l: number[] = []; for (let k = 0; k < n; k++) l.push(1000 + ((i * 31 + k * 7) % 4000)); l.sort((x, y) => x - y); lists.push(l); }
  const unionCache = new Map<string, number>(); const relationCache = new Map<string, number>();
  let hits = 0, sum = 0;
  for (let r = 0; r < 1500; r++) {
    for (let i = 0; i < lists.length; i++) {
      const key = getTypeListId(lists[i]);
      const cached = unionCache.get(key);
      if (cached !== undefined) { hits++; sum += cached; } else unionCache.set(key, key.length);
      const rk = relationKey(lists[i][0], lists[(i + 1) & 511][0], i & 3);
      const rc = relationCache.get(rk);
      if (rc !== undefined) hits++; else relationCache.set(rk, rk.length);
    }
  }
  console.log(hits, sum, unionCache.size, relationCache.size);
}
main();
