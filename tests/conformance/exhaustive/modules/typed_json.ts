// garnet:json (docs/typed_json_design.md): parse<T> validates the text against T, builds
// each object in the type's property order and drops undeclared properties; a TypeError
// names the path and the kinds; parseWithSchema takes the schema the exporter derives.
// Values print field by field (under Node a parse<T> without the exporter is the plain
// parse); the key order, the dropped extras and the error paths print through the schema form.
import { JSON as TJSON, parse, parseWithSchema } from "garnet:json";
enum Color { Red = "red", Blue = "blue" }
enum Level { Low, High }
interface Address { city: string; zip?: string }
type Tag = "a" | "b" | "c";
interface User { id: number; name: string; active: boolean; score: number | null; tags: Tag[]; address: Address; color: Color; level: Level; extra?: unknown }
type Tree = { v: number; kids: Tree[] };
type A = { b?: B }; type B = { a?: A; n: number };
type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };
type Pair = [number, string];
type Mixed = { a: number } & { b: string };
function attempt(name: string, f: () => unknown): string {
  try { const v = f(); return name + ":" + (typeof v === "object" ? JSON.stringify(v) : String(v)); }
  catch (e) { return name + ":" + (e as Error).constructor.name + ":" + (e as Error).message; }
}
function sum(n: Tree): number { let s = n.v; for (const k of n.kids) s += sum(k); return s; }
function main(): void {
  const out: string[] = [];
  const u = TJSON.parse<User>('{"name":"ann","id":7,"extra":[1,{"x":2}],"active":true,"score":null,"tags":["a","c"],"address":{"zip":"123","city":"Kyoto","country":"JP"},"color":"blue","level":1,"unknown":true}');
  out.push("user:" + [u.id, u.name, u.active, u.score, u.tags.join("+"), u.address.city, u.address.zip, u.color, u.level, JSON.stringify(u.extra)].join(","));
  const v: User = parse('{"id":1,"name":"bob","active":false,"score":2.5,"tags":[],"address":{"city":"Oslo"},"color":"red","level":0}');
  out.push("ctx:" + [v.id + 1, v.score, v.tags.length, v.address.zip === undefined, v.extra === undefined].join(","));
  out.push("prims:" + [parse<number>("-1.5e3"), parse<string>('"s\\n\\u00e9\\ud83d\\ude00"').length, parse<boolean>("true"), parse<null>("null"), parse<number | null>("null"), parse<Tag>('"b"'), parse<1 | 2>("2"), parse<boolean | null>("false")].join(","));
  const arr = parse<number[]>("[1, 2.5, -3, 1e2, 0]");
  out.push("array:" + arr.join(",") + " ro:" + parse<readonly string[]>('["x"]').length);
  const p = parse<Pair>('[1,"one"]'); out.push("tuple:" + p[0] + p[1]);
  const rec = parse<Record<string, number>>('{"a":1,"b":2}'); out.push("record:" + Object.keys(rec).join(",") + "=" + (rec.a + rec.b));
  out.push("tree:" + sum(parse<Tree>('{"v":1,"kids":[{"v":2,"kids":[]},{"v":3,"kids":[{"v":4,"kids":[]}]}]}')));
  const ab = parse<A>('{"b":{"n":1,"a":{"b":{"n":2}}}}'); out.push("mutual:" + ab.b!.a!.b!.n);
  const shapes = parse<Shape[]>('[{"kind":"circle","r":2},{"kind":"rect","w":3,"h":4}]');
  out.push("shapes:" + shapes.map((s) => s.kind === "circle" ? s.r * 2 : s.w * s.h).join(","));
  const m = parse<Mixed>('{"b":"x","a":1}'); out.push("mixed:" + m.a + m.b);
  const nested = parse<{ list: { n: number; s?: string }[]; deep: { a: { b: { c: number[] } } } }>('{"list":[{"n":1},{"n":2,"s":"two"}],"deep":{"a":{"b":{"c":[7,8]}}}}');
  out.push("nested:" + nested.list.map((e) => e.n + (e.s ?? "-")).join(",") + nested.deep.a.b.c[1]);
  out.push("undef-opt:" + String(parse<{ x: number | undefined; y: number }>('{"y":1}').x));
  out.push("ukey:" + parse<{ "ключ": number; "a b": string }>('{"a b":"sp","ключ":5}')["ключ"]);
  out.push("any:" + JSON.stringify(parse<unknown>('{"k":[1,"two",null,true,{"z":{}}]}')));
  out.push("ws:" + parse<number[]>(" \n[ 1 ,\t2 ] \r\n").length);
  // the schema form: the key order (the type's), the dropped extras, the last duplicate
  const S_USER = '{"s":{"k":"o","p":[["id","n",0],["name","s",0],["tags",{"k":"a","e":"s"},1]]}}';
  out.push(attempt("order", () => parseWithSchema('{"tags":["t"],"extra":1,"name":"n","id":3}', S_USER)));
  out.push(attempt("dup", () => parseWithSchema('{"id":1,"name":"a","id":2}', S_USER)));
  out.push(attempt("absent", () => parseWithSchema('{"id":1,"name":"a"}', S_USER)));
  // the error paths
  out.push(attempt("missing", () => parseWithSchema('{"id":1}', S_USER)));
  out.push(attempt("kind", () => parseWithSchema('{"id":"1","name":"a"}', S_USER)));
  out.push(attempt("deep", () => parseWithSchema('{"id":1,"name":"a","tags":["x",2]}', S_USER)));
  out.push(attempt("root", () => parseWithSchema('[1]', S_USER)));
  out.push(attempt("literal", () => parseWithSchema('"d"', '{"s":{"k":"u","m":[{"k":"l","v":"a"},{"k":"l","v":"b"}]}}')));
  out.push(attempt("union", () => parseWithSchema('{"kind":"tri","s":1}', '{"s":{"k":"u","m":[{"k":"o","p":[["kind",{"k":"l","v":"circle"},0],["r","n",0]]},{"k":"o","p":[["kind",{"k":"l","v":"rect"},0],["w","n",0]]}]}}')));
  out.push(attempt("tuple-len", () => parseWithSchema('[1]', '{"s":{"k":"t","e":["n","s"]}}')));
  out.push(attempt("tuple-more", () => parseWithSchema('[1,"a",3]', '{"s":{"k":"t","e":["n","s"]}}')));
  out.push(attempt("record", () => parseWithSchema('{"a":1,"b":"x"}', '{"s":{"k":"r","e":"n"}}')));
  out.push(attempt("ref", () => parseWithSchema('{"v":1,"kids":[{"v":"x","kids":[]}]}', '{"d":{"Tree":{"k":"o","p":[["v","n",0],["kids",{"k":"a","e":{"k":"ref","n":"Tree"}},0]]}},"s":{"k":"ref","n":"Tree"}}')));
  out.push(attempt("syntax", () => parseWithSchema('{"id":1,,}', S_USER)));
  out.push(attempt("trailing", () => parseWithSchema('{"id":1,"name":"a"} x', S_USER)));
  out.push(attempt("number", () => parseWithSchema('[01]', '{"s":{"k":"a","e":"n"}}')));
  out.push(attempt("number2", () => parseWithSchema('[1.]', '{"s":{"k":"a","e":"n"}}')));
  out.push(attempt("string", () => parseWithSchema('["a\tb"]', '{"s":{"k":"a","e":"s"}}')));
  out.push(attempt("escape", () => parseWithSchema('["\\q"]', '{"s":{"k":"a","e":"s"}}')));
  out.push(attempt("eof", () => parseWithSchema('{"id":1', S_USER)));
  out.push(attempt("empty", () => parseWithSchema('', S_USER)));
  out.push(attempt("bad-schema", () => parseWithSchema('1', '{"s":"q"}')));
  console.log(out.join(" | "));
}
main();
