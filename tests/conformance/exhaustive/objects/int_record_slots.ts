// Integer slots of records (docs/record_int_fields_design.md): an object literal's
// integer field that the program only uses as an integer (bitwise operators,
// an array index) is an int32 slot of the literal's shape. Every way the
// program can observe such a field must see a number: typed and dynamic
// reads, writes of integers, fractions, NaN, -0 and non-numbers (the object
// generalizes), the int32 edges, JSON, keys/values/entries, spread, for-in,
// delete, freeze, defineProperty, console.log, and the same site making
// integer-kinded and boxed objects. `v` is read as a double too, so it stays
// boxed; `flags` and `mask` are integer slots.
interface Nd { kind: number; flags: number; tag: number; v: number; name: string }
const enum K { A = 1, B = 2, C = 300 }
const enum F { None = 0, X = 1 << 3, Y = 1 << 5, Z = 1 << 9 }

function make(i: number): Nd {
  // the conditionals computed first: a literal whose initializers are plain locals is a layout
  const f = ((i & 1) === 0 ? F.X : F.Y) | ((i & 2) === 0 ? F.None : F.Z);
  const k = (i & 1) === 0 ? K.A : K.C;
  return { kind: k, flags: f, tag: i & 15, v: i | 0, name: "n" + i };
}
function count(ns: Nd[]): number {
  let sum = 0;
  for (const n of ns) {
    if (n.flags & F.X) sum++;
    if ((n.flags & (F.Y | F.Z)) === (F.Y | F.Z)) sum += 10;
    sum = (sum + (n.kind | 0) + (n.tag & 0xff)) | 0;
  }
  return sum;
}
function dyn(o: any, key: string): unknown { return o[key]; }
const table = [100, 200, 300, 400];
function pick(o: { mask: number; idx: number }): number { return table[o.idx & 3] + (o.mask >> 1); }

function main(): void {
  const ns: Nd[] = [];
  for (let i = 0; i < 8; i++) ns.push(make(i));
  console.log(count(ns), ns[3].flags, ns[3].kind, typeof ns[3].flags, ns[3].flags === (F.Y | F.Z));
  // integer writes stay integers; a fraction, a string, undefined, NaN, -0 and the int32 edges
  // generalize the slot (the object alone moves to the boxed sibling shape)
  ns[0].tag = 41; ns[0].tag = ns[0].tag ^ 3;
  ns[1].tag = 2.5;
  (ns[2] as any).tag = "two";
  (ns[3] as any).tag = undefined;
  ns[4].tag = NaN;
  ns[5].tag = -0;
  ns[6].tag = 2147483648;
  ns[7].tag = -2147483649;
  // (a string or undefined stored through `any` into a `number` field is read as a number by a
  // typed read, the typed profile's known deviation; the dynamic reads see the values)
  console.log(ns[0].tag, ns[1].tag, dyn(ns[2], "tag"), dyn(ns[3], "tag"), ns[4].tag, Object.is(ns[5].tag, -0), ns[6].tag, ns[7].tag);
  console.log(count(ns.slice(0, 2)), dyn(ns[0], "tag"), dyn(ns[1], "tag"), dyn(ns[5], "kind"), ns[0].tag & 7, ns[6].tag & 7, ns[7].tag | 0);
  // the other objects of the shape are untouched by one object's generalization
  const fresh = make(9);
  console.log(fresh.tag, fresh.kind, JSON.stringify(fresh), JSON.stringify(ns[1]), JSON.stringify(ns[2]));
  console.log(Object.keys(fresh).join(","), Object.values(fresh).join(","), Object.entries(fresh).map((e) => e.join("=")).join(";"));
  const copy = { ...fresh, extra: 7 };
  console.log((copy.tag | 0) + copy.extra, copy.kind, JSON.stringify(copy));
  const parsed = JSON.parse(JSON.stringify(ns)) as Nd[];
  console.log(parsed[0].tag, parsed[1].tag, dyn(parsed[2], "tag"), parsed[6].tag, count([parsed[0]]));
  let forin = "";
  for (const k in fresh) forin += k + ":" + (fresh as any)[k] + " ";
  console.log(forin.trim());
  // delete and defineProperty leave the hidden-class regime with the values intact
  const d = make(10);
  delete (d as any).name;
  console.log(d.tag, d.kind, JSON.stringify(d));
  const e = make(11);
  Object.defineProperty(e, "tag", { value: 99, writable: false });
  try { (e as any).tag = 1; } catch (err) { console.log((err as Error).name); }
  console.log(e.tag, Object.getOwnPropertyDescriptor(e, "tag")!.writable, Object.getOwnPropertyDescriptor(e, "kind")!.value);
  const fz = Object.freeze(make(12));
  try { (fz as any).tag = 1; } catch (err) { console.log((err as Error).name); }
  console.log(fz.tag, Object.isFrozen(fz));
  // a literal whose integer initializer is sometimes a fraction at run time
  const mixed: Nd[] = [];
  for (let i = 0; i < 4; i++) { const fl = i === 2 ? 0.5 : i; mixed.push({ kind: K.B, flags: F.X, tag: fl, v: i, name: "m" }); }
  console.log(mixed.map((m) => m.tag).join(","), count(mixed));
  // negative integers, zero and the int32 minimum in integer slots; an index and a shift
  const neg = [{ mask: -5, idx: 0 }, { mask: 0, idx: 1 }, { mask: -2147483648, idx: 2 }, { mask: 2147483647, idx: 7 }];
  console.log(neg.map(pick).join(","), neg[0].mask & 0xff, neg[2].mask >> 31, neg[3].mask ^ 1);
  console.log(fresh, neg[0]);
}
main();
