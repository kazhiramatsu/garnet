// Logical operators in condition position (if, while, for, ?:, under !): lowered
// as short-circuit control flow over a truth flag rather than a materialized value.
// Truthiness of every operand kind, short-circuit side effects, nested chains,
// negations, loops and the ternary, against V8.
let log: string[] = [];
function t(tag: string, v: unknown): unknown { log.push(tag); return v; }
interface Nd { flags: number; parent?: Nd; name?: string; v: number | string | undefined; }
function main(): void {
  const vals: unknown[] = [0, 1, -0, NaN, "", "x", null, undefined, true, false, {}, [], 2.5, -1];
  let out: string[] = [];
  for (const a of vals) for (const b of vals) {
    let r = "";
    if (a && b) r += "A"; else r += "a";
    if (a || b) r += "O"; else r += "o";
    if (!(a && b)) r += "N"; else r += "n";
    if (!a || !b) r += "P"; else r += "p";
    if ((a && b) || (!a && !b)) r += "E"; else r += "e";
    r += a && b ? "1" : "0";
    out.push(r);
  }
  console.log(out.join(","));
  // short-circuit: the right side runs only when needed, once
  log = [];
  if (t("a", 0) && t("b", 1)) console.log("bad"); else console.log("and-false", log.join(""));
  log = [];
  if (t("a", 1) || t("b", 1)) console.log("or-true", log.join(""));
  log = [];
  if (t("a", "") || t("b", null) || t("c", "z")) console.log("or-chain", log.join(""));
  log = [];
  if (!(t("a", 1) && t("b", 0)) && t("c", 2)) console.log("neg-chain", log.join(""));
  // loops with logical conditions, the flag re-evaluated each round
  let i = 0, n = 0;
  while (i < 10 && (i & 1) === 0 || i === 7) { i++; n++; }
  console.log("while", i, n);
  for (let k = 0; k < 20 && !(k > 5 && (k & 1)); k++) n += k;
  console.log("for", n);
  // tsc-style: fields of unions, optional chains, numbers and strings mixed
  const ns: Nd[] = [];
  for (let j = 0; j < 64; j++) ns.push({ flags: j, parent: j ? ns[j >> 1] : undefined, name: (j & 3) ? "x" + j : undefined, v: j % 3 === 0 ? j : j % 3 === 1 ? "s" : undefined });
  let sum = 0;
  for (const nd of ns) {
    if (nd.flags & 16 && !(nd.flags & 32)) sum++;
    if (nd.parent?.parent && nd.parent.parent.flags & 1) sum += 2;
    if (nd.name && nd.name.length > 2 || nd.v === undefined) sum += 3;
    if (typeof nd.v === "number" && nd.v % 2 === 0 || typeof nd.v === "string" && nd.v === "s") sum += 5;
    sum += nd.parent && nd.parent.name ? 7 : 11;
  }
  console.log("sum", sum);
  // NaN and -0 in numeric flags; a double that is not an integer
  const x = NaN, y = -0, z = 0.5;
  if (x && 1) console.log("bad"); else console.log("nan-falsy");
  if (y || z) console.log("negzero-falsy, half-truthy");
  if (z && x) console.log("bad"); else console.log("half-and-nan");
}
main();
