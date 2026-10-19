// tsc SymbolLinks pattern: an empty class expression (brand only) whose instances
// receive their properties lazily, read back through optional fields.
interface Links { _brand?: any; type?: number; target?: Links | undefined; resolved?: boolean; count?: number; name?: string; }
const Links = class implements Links { declare _brand: any; };
const table: (Links | undefined)[] = [];
function getLinks(id: number): Links { return table[id] ??= new Links(); }
function main(): void {
  for (let i = 0; i < 4000; i++) table.push(undefined);
  let sum = 0;
  for (let r = 0; r < 6000; r++) {
    for (let i = 0; i < 4000; i++) {
      const l = getLinks(i);
      if (l.type === undefined) { l.type = i & 15; l.resolved = (i & 1) === 0; }
      if ((i & 3) === 0 && l.count === undefined) l.count = 0;
      if (l.count !== undefined) l.count++;
      if ((i & 7) === 0) l.target = getLinks((i + 1) & 4095);
      sum += l.type + (l.resolved ? 1 : 0) + (l.target !== undefined && l.target.type !== undefined ? l.target.type : 0);
    }
    if ((r & 31) === 0) { for (let i = 0; i < 4000; i += 97) table[i] = undefined; }
  }
  console.log(sum);
}
main();
