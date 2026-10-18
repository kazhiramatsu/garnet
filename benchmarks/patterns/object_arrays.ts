// Arrays of interface-typed objects: push, index reads, length loops, for-of, nested fields.
interface Sym { name: string; flags: number; decls: Decl[]; }
interface Decl { kind: number; sym: Sym; }
function main(): void {
  const syms: Sym[] = [];
  for (let i = 0; i < 500; i++) { const s: Sym = { name: "s" + i, flags: i & 15, decls: [] };
    for (let j = 0; j < (i % 4) + 1; j++) s.decls.push({ kind: j, sym: s }); syms.push(s); }
  let sum = 0;
  for (let r = 0; r < 32000; r++) {
    for (let i = 0; i < syms.length; i++) { const s = syms[i]; const ds = s.decls;
      for (let j = 0; j < ds.length; j++) sum += ds[j].kind + (ds[j].sym.flags & 1); }
    for (const s of syms) if (s.flags & 8) sum++;
  }
  console.log(sum);
}
main();
