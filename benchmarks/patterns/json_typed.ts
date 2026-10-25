// Typed JSON (docs/typed_json_design.md): a document of records parsed through garnet:json's
// parse<T>, validated against the type and built in its layout; the checksum reads every field.
import { parse } from "garnet:json";
type Item = { id: number; name: string; price: number; tags: string[]; dims: { w: number; h: number }; active: boolean };
function makeDocument(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push('{"id":' + i + ',"name":"item-' + i + '","price":' + ((i % 100) + 0.25) + ',"tags":["t' + (i % 7) + '","u' + (i % 3) + '"],"dims":{"w":' + (i % 50) + ',"h":' + (i % 30) + '},"active":' + (i % 2 === 0) + '}');
  return "[" + parts.join(",") + "]";
}
function checksum(items: Item[]): number {
  let s = 0;
  for (const it of items) s += it.id + it.price + it.tags.length + it.dims.w * it.dims.h + (it.active ? 1 : 0) + it.name.length;
  return s;
}
function main(): void {
  const text = makeDocument(20000);
  let acc = 0;
  for (let r = 0; r < 25; r++) acc += checksum(parse<Item[]>(text));
  console.log(Math.round(acc));
}
main();
