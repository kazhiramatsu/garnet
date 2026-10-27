// garnet real-project benchmark: prisma's schema language tools (benchmarks/real/run.sh prisma). Prisma 8's PSL
// parser, printer and formatter (pure TypeScript workspace packages, mapped by paths.js) over the repository's
// largest schema: parsed many times, then formatted (a parse and a print of the syntax tree) many times; the
// checksum adds the diagnostics, the formatted length and a hash of the formatted text, so the native and the Node
// runs must agree.
import { parse } from "@internal/psl-parser/syntax";
import { format } from "@internal/psl-parser/format";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
function main(): void {
  const source = readFileSync("packages/3-extensions/supabase/src/contract/contract.prisma", "utf8");
  const t0 = performance.now();
  let diags = 0, formatted = 0, h = 0;
  for (let i = 0; i < 100; i++) diags += parse(source, "contract.prisma").diagnostics.length;
  for (let i = 0; i < 50; i++) { const text = format(source); formatted += text.length; h = (h + hash(text)) | 0; }
  const ms = performance.now() - t0;
  process.stderr.write(`prisma psl: ${ms.toFixed(1)} ms (100 parses, 50 formats of ${source.split("\n").length} lines)\n`);
  console.log(`prisma psl: diagnostics ${diags} formatted ${formatted} hash ${h}`);
}
main();
