// Words that are no ordinary value in value slots, under collections (docs/unmasked_pointers_design.md,
// section 5): the integer slots of records (the small integer, which no scan may take for a reference)
// and a sparse array's side table, kept alive across many young and old collections.
interface P { x: number; y: number; id: number; name: string }
function mk(i: number): P {
  const x = i & 0xffff, y = (i * 7) & 0xffff, id = i | 0;
  return { x: x, y: y, id: id, name: "p" + (i % 10) };
}
function main(): void {
  const keep: P[] = [];
  const sparse: number[] = [];
  sparse[5] = 1; sparse[1000000] = 2; sparse[50000000] = 3;
  let acc = 0;
  for (let round = 0; round < 40; round++) {
    const tmp: P[] = [];
    for (let i = 0; i < 500; i++) tmp.push(mk(round * 500 + i));
    for (const p of tmp) acc = (acc + (p.x ^ p.y) + (p.id & 0xff)) | 0;
    keep.push(tmp[round % 500]);
    sparse[round * 1000003] = round;
    const junk = { a: "x".repeat(round % 7), b: [round, round + 1] };
    acc = (acc + junk.b.length) | 0;
  }
  let check = 0;
  for (const p of keep) check = (check + (p.x | 0) + (p.y & 0xffff) + (p.id >> 1)) | 0;
  let sp = 0;
  for (const k in sparse) sp += sparse[Number(k)];
  console.log(acc, check, keep.length, sp, sparse.length, keep[7].name, JSON.stringify(keep[3]));
}
main();
