// Maps keyed by small integer ids (tsc's nodeLinks, symbolLinks, resolvedSymbols,
// flow caches): set once, then get/has in the hot loops, with a one-entry cache in
// front as the checker's accessors have.
interface Links { resolved: number; flags: number; }
class Table {
  readonly map = new Map<number, Links>();
  lastId = -1; last: Links | undefined = undefined;
  links(id: number): Links {
    if (this.lastId !== id) { this.lastId = id; this.last = this.map.get(id); }
    let l = this.last;
    if (l === undefined) { l = { resolved: 0, flags: 0 }; this.map.set(id, l); this.last = l; }
    return l;
  }
}
function main(): void {
  const t = new Table();
  const ids: number[] = []; for (let i = 0; i < 262144; i++) if ((i * 7919) % 5 !== 0) ids.push(i);
  let sum = 0;
  for (let r = 0; r < 12; r++) {
    for (let k = 0; k < ids.length; k++) { const l = t.links(ids[k]); l.resolved += r; l.flags |= 1 << (k & 7); }
    for (let k = 0; k < ids.length; k += 3) { const id = ids[k] + 1; if (t.map.has(id)) sum += t.map.get(id)!.resolved; }
  }
  console.log(t.map.size, sum);
}
main();
