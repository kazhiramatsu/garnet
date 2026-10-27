// garnet real-project benchmark: yaml (eemeli/yaml; benchmarks/real/run.sh yaml). A document of records is
// parsed to plain values, stringified back, and parsed through the Document API many times; the checksum adds
// the parsed fields, the lengths and a hash of the output, so the native and the Node runs must agree.
import * as YAML from "./src/index.ts";
import { performance } from "node:perf_hooks";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) | 0;
  return h;
}
function buildText(records: number): string {
  const lines: string[] = ["# the inventory", "version: 3", "items:"];
  for (let i = 0; i < records; i++) {
    lines.push(`  - id: ${i}`, `    name: "item ${i}"`, `    price: ${(i * 7) % 100}.${i % 10}`, `    tags: [a, b${i % 5}, "c d"]`,
      `    active: ${i % 3 === 0}`, `    note: >`, `      a folded`, `      block for ${i}`);
    if (i % 4 === 0) lines.push(`    meta: { k: v${i}, n: ${i} }`);
  }
  lines.push("owner:", "  name: Kaz", "  roles: [admin, dev]");
  return lines.join("\n") + "\n";
}
/** Distinct string objects of the text: a program's input arrives as a fresh string (V8 caches by identity). */
const VARIANTS = 16;
function variants(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < VARIANTS; i++) out.push(text.split("").join(""));
  return out;
}
interface Item { id: number; name: string; price: number; tags: string[]; active: boolean; note: string; meta?: { k: string; n: number } }
function main(): void {
  const text = buildText(60);
  const texts = variants(text);
  const t0 = performance.now();
  let fields = 0, lengths = 0, h = 0;
  for (let it = 0; it < 300; it++) {
    const v = YAML.parse(texts[it & (VARIANTS - 1)]) as { version: number; items: Item[]; owner: { name: string; roles: string[] } };
    for (const item of v.items) fields += item.id + item.price + item.tags.length + (item.active ? 1 : 0) + item.note.length + (item.meta ? item.meta.n : 0);
    fields += v.version + v.owner.roles.length;
    const out = YAML.stringify(v);
    lengths += out.length;
    h = (h + hash(out)) | 0;
    const doc = YAML.parseDocument(texts[(it + 3) & (VARIANTS - 1)]);
    const js = doc.toJS() as { items: Item[] };
    fields += js.items.length + doc.errors.length;
  }
  const ms = performance.now() - t0;
  process.stderr.write(`yaml: ${ms.toFixed(1)} ms (300 parse+stringify+document rounds, ${text.split("\n").length} lines)\n`);
  console.log(`yaml: fields ${fields} lengths ${lengths} hash ${h}`);
}
main();
