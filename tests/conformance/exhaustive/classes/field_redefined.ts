// A class field redefined with non-default attributes on one instance (yaml's Collection: `Object.defineProperty(this,
// 'schema', { value, configurable: true, enumerable: false, writable: true })` in the constructor): the field keeps
// its value and its typed reads and writes, but leaves Object.keys, JSON.stringify, for-in, spread, assign, entries
// and console.log; getOwnPropertyNames, Reflect.ownKeys and the descriptors still see it; a later redefinition
// restores it on that instance alone or makes it non-configurable (then a redefinition and a delete are refused);
// a delete of the hidden field keeps the other properties; a subclass instance behaves the same; a frozen
// instance's descriptor says so; the other classes' fields stay enumerable.
interface Schema { name: string }
class Collection {
  schema: Schema | undefined = undefined;   // initialized: declared where it is defined under both class-field semantics
  items: number[] = [];
  constructor(schema?: Schema) {
    Object.defineProperty(this, "schema", { value: schema, configurable: true, enumerable: false, writable: true });
  }
  count(): number { return this.items.length; }
}
class Seq extends Collection {
  flow = false;
  constructor(schema?: Schema) { super(schema); this.items.push(1, 2); }
}
class Plain { constructor(public schema: Schema, public items: number[]) {} }
function main(): void {
  const out: string[] = [];
  const s: Schema = { name: "core" };
  const c = new Collection(s);
  out.push(String(c.schema === s), Object.keys(c).join(","), JSON.stringify(c), String(c.count()));
  c.schema = { name: "other" };
  out.push(String(c.schema!.name), Object.keys(c).join(","), String(c.propertyIsEnumerable("schema")), String(c.hasOwnProperty("schema")), String("schema" in c));
  // the hidden field read and written through untyped receivers (the generic and the cached paths)
  const anyC: any = c;
  anyC.schema = { name: "dyn" };
  const recs: Record<string, unknown>[] = [c as unknown as Record<string, unknown>, { schema: { name: "lit" } }, new Seq(s) as unknown as Record<string, unknown>];
  out.push(String(anyC.schema.name), String((c as unknown as Record<string, unknown>)["schema"] === anyC.schema), recs.map((r) => (r.schema as Schema).name).join(","), String(c.schema!.name));
  const d = Object.getOwnPropertyDescriptor(c, "schema")!;
  out.push([d.value.name, d.writable, d.enumerable, d.configurable].join(" "));
  out.push(Object.getOwnPropertyNames(c).join(","), Reflect.ownKeys(c).map(String).join(","), Object.keys(Object.getOwnPropertyDescriptors(c)).join(","));
  const forIn: string[] = []; for (const k in c) forIn.push(k);
  out.push(forIn.join(","), Object.keys({ ...c }).join(","), Object.keys(Object.assign({}, c)).join(","), Object.entries(c).map(([k, v]) => k + "=" + JSON.stringify(v)).join(";"));
  out.push(Object.keys(new Plain(s, [3])).join(","));
  const seq = new Seq(s);
  out.push(Object.keys(seq).join(","), JSON.stringify(seq), String(seq.count()), String(seq instanceof Collection), String(seq.schema === s));
  // restore enumerable on one instance: the other keeps the hidden field
  const c2 = new Collection(s);
  Object.defineProperty(c2, "schema", { enumerable: true });
  out.push(Object.keys(c2).join(","), Object.keys(c).join(","), JSON.stringify(c2));
  // non-configurable: a redefinition of enumerable and a delete are refused (strict code throws the TypeError)
  Object.defineProperty(c2, "schema", { configurable: false });
  let refused = 0;
  try { Object.defineProperty(c2, "schema", { enumerable: false }); } catch (e) { refused += e instanceof TypeError ? 1 : 0; }
  try { delete (c2 as { schema?: Schema }).schema; } catch (e) { refused += e instanceof TypeError ? 1 : 0; }
  out.push(String(refused), String(c2.schema === s), String(Object.getOwnPropertyDescriptor(c2, "schema")!.configurable), Object.keys(c2).join(","));
  // a delete of the hidden field: the field is gone, the rest stays
  const c3 = new Collection(s);
  c3.items.push(9);
  out.push(String(delete (c3 as { schema?: Schema }).schema), String(c3.schema), Object.keys(c3).join(","), String(c3.count()), String(c3.hasOwnProperty("schema")));
  // a frozen instance's hidden field: the descriptor says so
  const c4 = new Collection(s);
  Object.freeze(c4);
  const d4 = Object.getOwnPropertyDescriptor(c4, "schema")!;
  out.push([d4.writable, d4.enumerable, d4.configurable].join(" "), String(Object.isFrozen(c4)));
  console.log(out.join("\n"));
  console.log(c, seq);
}
main();
