// A user's own property whose name starts with "__" (`__typename`, vue's `__v_skip`) is an
// ordinary property: enumerated, serialized and copied like any other. The runtime's internal
// slots (a Date's, a RegExp's, a generator's, an iterator's) stay hidden, as V8 has none.
class Node { __parent: Node | null = null; id: number; constructor(id: number) { this.id = id; } }
function* gen() { yield 1; }
function main(): void {
  const o: any = { a: 1, __typename: "User", __v_skip: true };
  o["__" + "dyn"] = 2; o.__x = 3;
  console.log(Object.keys(o).join(","), JSON.stringify(o), Object.getOwnPropertyNames(o).join(","));
  for (const k in o) console.log(k, o[k]);
  console.log(Object.entries(o).map(([k, v]) => k + "=" + v).join(";"), Object.values(o).length);
  const copy = { ...o }; const assigned = Object.assign({}, o);
  console.log(JSON.stringify(copy), Object.keys(assigned).length, "__typename" in copy, copy.__typename);
  const n = new Node(7); n.__parent = new Node(8);
  console.log(Object.keys(n).join(","), JSON.stringify(n));
  const parsed = JSON.parse('{"__typename":"Q","__v_raw":1,"x":2}');
  console.log(Object.keys(parsed).join(","), parsed.__typename, JSON.stringify(parsed));
  const frozen = Object.freeze({ __id: 1 });
  console.log(Object.keys(frozen).join(","), Object.getOwnPropertyDescriptor(o, "__typename")?.enumerable, Object.hasOwn(o, "__dyn"));
  // the runtime's own slots stay invisible
  const d = new Date(0); const re = /a+/g; const g = gen();
  console.log(Object.keys(d).length, JSON.stringify(d), Object.getOwnPropertyNames(d).length, Object.keys(g).length, Object.keys(re).join(","), JSON.stringify(re));
  console.log(Object.keys(globalThis).some((k) => k.startsWith("__garnet")));
  const m = new Map([["k", 1]]); const it = m.entries(); const ai = [1, 2].values();
  console.log(Object.keys(it).length, Object.keys(ai).length, JSON.stringify(it), JSON.stringify({ ...d }));
}
main();
