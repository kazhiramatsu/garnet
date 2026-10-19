// Arrays carry their named properties as shaped slots (docs/shaped_array_props_design.md):
// the compiler's NodeArray sets pos/end/hasTrailingComma/transformFlags on
// arrays, and the property caches now serve arrays like plain objects (every
// named key but the virtual `length`). Every observable result must match V8:
// reads and writes of named properties through typed and `any` receivers,
// `length` and indices beside them, Object.keys / for..in order (indices
// first, then names in insertion order), delete and re-add, JSON.stringify,
// slice/concat/spread dropping the names, frozen arrays, sparse arrays,
// arrays of different lengths sharing the names, and many arrays in a loop.
interface Nd { kind: number; }
interface NodeArr extends Array<Nd> { pos: number; end: number; hasTrailingComma?: boolean; transformFlags?: number; }
function createNodeArray(elems: Nd[], pos: number, end: number, trailing: boolean): NodeArr {
  const arr = elems as NodeArr;
  arr.pos = pos; arr.end = end; arr.hasTrailingComma = trailing;
  if (trailing) arr.transformFlags = 7;
  return arr;
}
function span(a: NodeArr): number { return a.end - a.pos; }
function describe(a: NodeArr): string { return [a.length, a.pos, a.end, a.hasTrailingComma, a.transformFlags, a[0]?.kind].join("/"); }
function main(): void {
  const a = createNodeArray([{ kind: 1 }, { kind: 2 }], 10, 20, false);
  const b = createNodeArray([{ kind: 3 }], 30, 45, true);
  const c = createNodeArray([], 0, 0, false);
  console.log(describe(a), describe(b), describe(c), span(a) + span(b));
  a.pos = 11; b.end = 50; c.transformFlags = 9; (a as any).extra = "x";
  console.log(describe(a), describe(b), describe(c), (a as any).extra, (a as any).missing);
  console.log(Object.keys(a).join(","), Object.keys(c).join(","), JSON.stringify(a), JSON.stringify(c));
  const seen: string[] = [];
  for (const k in b) seen.push(k);
  console.log(seen.join(","), "pos" in b, "2" in b, "length" in b, b.hasOwnProperty("pos"), b.hasOwnProperty("length"));
  // length and indices beside the names
  a.push({ kind: 7 }); a[5] = { kind: 8 }; a.length = 2;
  console.log(a.length, describe(a), Object.keys(a).join(","));
  // delete and re-add: the array leaves the shaped regime and keeps working
  delete (b as any).hasTrailingComma;
  console.log(describe(b), Object.keys(b).join(","));
  b.hasTrailingComma = false; b.pos = 31;
  console.log(describe(b), Object.keys(b).join(","));
  // copies drop the names
  const s = a.slice(0) as NodeArr, cc = a.concat([{ kind: 9 }]) as NodeArr, sp = [...a] as NodeArr;
  // (a missing `number` field read through the typed receiver is the known
  // typed-mode deviation, so the names' absence is observed with `in`)
  console.log("pos" in s, "pos" in cc, "pos" in sp, s.length, cc.length, sp.length);
  // frozen: the named write throws in strict mode, reads work
  const f = Object.freeze(createNodeArray([{ kind: 4 }], 1, 2, false)) as NodeArr;
  try { f.pos = 99; console.log("no throw"); } catch (err: any) { console.log("frozen", err instanceof TypeError, f.pos); }
  // sparse array with names
  const sparse: NodeArr = [] as unknown as NodeArr;
  sparse[1000] = { kind: 5 }; sparse.pos = 3; sparse.end = 4;
  console.log(sparse.length, sparse.pos, span(sparse), Object.keys(sparse).join(","));
  // any receivers and a plain object with the same keys through the same function
  const plain = { pos: 100, end: 150, length: 0 } as unknown as NodeArr;
  console.log(span(plain), (plain as any).length, span(createNodeArray([], 5, 9, true)));
  // many arrays: the caches see one shape family
  let total = 0;
  const arrays: NodeArr[] = [];
  for (let i = 0; i < 5000; i++) arrays.push(createNodeArray(i % 2 ? [{ kind: i }] : [], i, i + (i % 7), i % 3 === 0));
  for (const x of arrays) total += span(x) + x.length + (x.hasTrailingComma ? 1 : 0) + (x.transformFlags ?? 0);
  for (const x of arrays) { x.pos += 1; x.end += 2; }
  for (const x of arrays) total += span(x);
  console.log(total, arrays[4999].pos, arrays[4998].transformFlags);
}
main();
