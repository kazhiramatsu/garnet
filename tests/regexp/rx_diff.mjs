#!/usr/bin/env node
// The engine's differential test against V8 (docs/regexp_vm_design.md): builds the test driver
// runtime/regexp/rx_cli from the engine sources, feeds it (pattern, flags, input, start) cases and
// compares each result with `new RegExp(pattern, flags + "gd").exec(input)` from lastIndex = start
// (the indices of every group). Usage: node tests/regexp/rx_diff.mjs [--random N] [--seed S] [--show K]
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(root, "runtime/regexp");
const cli = path.join(root, "build/rx_cli");
const srcs = ["rx_set.c", "rx_unicode.c", "rx_parse.c", "rx_compile.c", "rx_vm.c", "rx_cli.c"].map((f) => path.join(dir, f));
function build() {
  const newest = Math.max(...readdirSync(dir).map((f) => statSync(path.join(dir, f)).mtimeMs));
  if (existsSync(cli) && statSync(cli).mtimeMs > newest) return;
  const r = spawnSync("cc", ["-std=c11", "-O2", "-Wall", "-Wno-unused-function", "-o", cli, ...srcs], { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
}

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const NRANDOM = +opt("--random", 2000);
const SEED = +opt("--seed", 1);
const SHOW = +opt("--show", 25);

// ---- the hand-written cases: [pattern, flags, input, start?] ----
const cases = [];
const add = (p, f, i, s = 0) => cases.push([p, f, i, s]);
const inputs = ["", "a", "b", "ab", "ba", "aab", "abc", "abab", "aaa", "xyz", "a b", "A", "AB", "aB", "ab\ncd", "cd\nab", "foo bar", "123", "a1b2", "\u00e9", "\u00c9t\u00e9", "\u017f", "\u212a", "\ud83d\ude00", "a\ud83d\ude00b", "\ud83d", "\ude00", "\ud83d\ude00\ud83d\ude00", "\u03a3\u03c3\u03c2", "\u0130i\u0131I"];
const simple = ["a", "ab", "a|b", "a*", "a+", "a?", "a*?", "a+?", "a??", "(a)", "(a|b)+", "(?:ab)+", "a{2}", "a{1,2}", "a{2,}", "a{0}", "a{0,1}b", ".", ".*", ".+?", "^a", "a$", "^$", "^", "$", "\\b", "\\B", "[ab]", "[^ab]", "[a-c]", "[^a-c]", "\\d", "\\D", "\\w", "\\W", "\\s", "\\S", "(a)(b)", "(a)|(b)", "(a)\\1", "(a*)\\1", "(?:a|b)*c", "(a*)*b", "(a*)?b", "(a|)*b", "(a*?)*b", "(?:a|())*b", "(a){0}b", "(a*){2,3}b", "(a|b)*?c", "(z)((a+)?(b+)?(c))*", "(?=a)", "(?!a)", "a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b", "(?<=(a))b", "(?=(a+))a*b\\1", "(?!(a))b", "(?<=\\1(a))b", "(?<=(\\d+)(\\d+))$", "(?:a|b)(?:a|b)", "[\\b]", "\\0", "\\x41", "\\u0041", "\\cJ", "\\n", "a\\nb", "(?<n>a)\\k<n>", "(?<n>a)|(?<n>b)", "(?<x>a)|(?<x>b)\\k<x>", "\\p{L}", "\\P{L}", "\\p{Lu}", "\\p{Script=Greek}", "\\p{scx=Latn}", "[\\p{L}]", "[^\\p{L}]", "\\u{1F600}", ".", "^.$", "^..$", "[\\ud83d\\ude00]", "[^a]", "\\ud83d", "\\ude00", "(.)(.)", "(?<=.)", "a.c", "a[^b]c", "(a)(?:b)(c)", "((a)|(b))+", "(a|ab)(c|bcd)(d*)", "(.*?)a(?!(a+)b\\2c)\\2(.*)", "x*", "(x*)*", "(?:)", "()", "(|a)", "(a|)", "\\s+", "[ \\t]+", "\\S+", "a|", "|a", "(?:a|b|c)+", "(?i:a)b", "(?-i:a)B", "(?i:(?-i:a))", "(?s:.)", "(?m:^b)", "(?m:a$)", "\\u017f", "k", "K", "[a-z]", "\\w+", "\\bx", "s", "\\u00df", "\\u1e9e", "\u03a3", "i", "\u0130"];
for (const p of simple) for (const f of ["", "i", "m", "s", "u", "iu", "ms", "y", "g"]) {
  for (const inp of inputs) add(p, f, inp, 0);
}
// starts other than 0
for (const p of ["a", "b", "^a", "a$", "\\b", "(?<=a)b", ".", "\\ude00", "\\ud83d"]) for (const f of ["", "u", "y", "uy", "m"]) for (const inp of ["abab", "a\ud83d\ude00b", "\ud83d\ude00", "ab\nab"]) for (const s of [0, 1, 2, 3, 4, 5]) add(p, f, inp, s);
// Annex B syntax and errors
const annexB = ["\\8", "\\9", "\\18", "\\400", "\\377", "\\07", "\\08", "\\00", "\\c", "\\c0", "\\c\u00e9", "[\\c]", "[\\c_]", "[\\c1]", "\\k", "(?<a>x)\\k", "\\k<a>", "(?<a>x)\\k<b>", "[\\d-a]", "[a-\\d]", "[\\s-a]", "a{", "a{1", "a{1,", "a{,1}", "{", "}", "]", "{1}", "a{1}{2}", "a{2,1}", "a**", "a+?+", "(?=a)*", "(?=a){2}", "(?!a)+", "(?<=a)+", "^*", "$+", "\\b*", "(", ")", "(?", "(?<a", "(?<>x)", "(?<1>x)", "[", "[b-a]", "\\", "a\\", "(?i-i:a)", "(?x:a)", "(?i)", "(?-:a)", "(?i-:a)", "(?-i:a)", "(?<n>a)(?<n>b)", "(?<n>a)|(?<n>b)", "((?<n>a))|(?<n>b)", "(?:(?<n>a)|b)(?<n>c)", "\\p{Foo}", "\\p{L", "\\p{gc=Lu}", "\\p{Lu=x}", "\\p{Script=Foo}", "\\p{uppercase}", "\\p{IDS_Unary_Operator}", "\\u{110000}", "\\u{", "\\u{}", "\\x1", "\\x", "\\z", "\\-", "\\q{a}", "[\\B]", "[\\k]", "(?<a>x)[\\k]", "[\\1]", "(a)\\2", "\\1", "[\\p{L}]", "\\p{L}", "[\\-]", "[a-]", "[-a]", "[\\d-]", "x{2,1}?", "(?<\\u{1d49c}>a)\\k<\\u{1d49c}>", "(?<\\ud835\\udc9c>a)", "(?<\ud835\udc9c>a)", "(?<a\\u200cb>x)", "(?<$_>x)", "(?<_$>x)"];
for (const p of annexB) for (const f of ["", "u", "v"]) add(p, f, "a1\\b8c", 0);
// v-mode classes
const vmode = ["[\\q{a|bc}]", "[\\q{a|bc}]b", "[\\q{ab|a}]b", "[\\q{a|bc}--\\q{bc}]", "[[a-z]--[aeiou]]", "[[a-z]&&[aeiou]]", "[a-z&&b]", "[&]", "[a&&&b]", "[!!]", "[\\&&]", "[.]", "[\\.]", "[/]", "[-]", "[\\-]", "[\\b]", "[\\q{}]", "[^\\q{a|b}]", "[^\\q{ab}]", "[\\q{ab}]", "[a-z-]", "[\\p{L}--[a-z]]", "[\\p{L}&&\\p{Lu}]", "[[\\p{L}--\\p{Lu}]&&[a-z]]", "[^[a-z]]", "[[^a-z]]", "[\\q{abc|ab|a}]", "[\\q{\ud83d\ude00|a}]", "[a-z[0-9]]", "[\\w--_]", "[\\d\\q{x}]", "[^\\d]", "[[a]&&[a]&&[a]]", "[[ab]--[a]--[b]]"];
// a `v` class with \q{...} under `i`: V8 compares the single-character part without canonicalizing
// the input (/[\q{A}]/vi fails on "A"); the engine follows the specification, so those stay out
for (const p of vmode) for (const f of ["v", "vi"]) { if (f === "vi" && p.includes("\\q")) continue; for (const inp of ["", "a", "ab", "abc", "bc", "x", "A", "_", "9", "\ud83d\ude00", "aaa"]) add(p, f, inp, 0); }
// case-insensitivity specifics
const casey = ["s", "\\u017f", "k", "\\u212a", "i", "\\u0130", "\\u0131", "\\u00df", "\\u1e9e", "\\u03c3", "\\u03c2", "\\u03a3", "\\u1e9b", "\\u0345", "\\u0399", "\\u1fbe", "[a-z]", "[^a-z]", "\\w", "\\W", "\\bx", "(a)\\1", "(\\u017f)\\1", "[\\u017f]", "[\\u212a]", "[s]", "[k]", "\\u00b5", "\\u039c", "\\u03bc", "\\u{10400}", "\\u{10428}", "[\\u{10400}-\\u{10402}]", "\\p{Lu}", "\\p{Ll}", "[\\p{Lu}]"];
const caseInputs = ["s", "S", "\u017f", "k", "K", "\u212a", "i", "I", "\u0130", "\u0131", "\u00df", "\u1e9e", "\u03c3", "\u03c2", "\u03a3", "\u1e9b", "\u1e61", "\u0345", "\u0399", "\u03b9", "\u1fbe", "\u00b5", "\u039c", "\u03bc", "\u{10400}", "\u{10428}", "\u{10401}", "aA", "\u017fs", "\u017fx", "sx", " x", "x"];
for (const p of casey) for (const f of ["i", "iu", "", "u"]) for (const inp of caseInputs) add(p, f, inp, 0);
// quantifier nesting and backtracking depth
const quant = ["(a+)+b", "(a|aa)+b", "(a*)*c", "(?:a+)+$", "(a?){3}b", "(a{2,3}){2}", "a{3,5}?a", "(ab|a)(bc|c)", "(ab|a)(bc|c)?$", "(a+?)(a*)", "(a*)(a*)", "(a*?)(a*?)$", "a*b*c*", "(?:a*)*", "(?:a?)*", "(?:|a)*b", "(a|b|c){2,3}", "((a)|b)*", "((a)|b)*c", "(a(b)?)+", "(a)|b", "b|(a)", "(?:(a)|(b)|(c))+", "(?:(a)|(b)|(c)){2}", "x(?=(a))\\1", "(?=(a))\\1", "(?<=(a))\\1"];
for (const p of quant) for (const f of ["", "i"]) for (const inp of ["", "a", "aa", "aaa", "aaaa", "ab", "aab", "abc", "aabbcc", "abcabc", "ac", "bc", "aaaaaaaaaaaaaaaaaaaaaaaab", "abab", "aba"]) add(p, f, inp, 0);

// ---- random cases ----
let seed = SEED >>> 0;
function rnd(n) { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; }
function pick(a) { return a[rnd(a.length)]; }
function genAtom(depth, ctx) {
  const r = rnd(20);
  if (depth > 2 || r < 6) return pick(["a", "b", "c", ".", "[ab]", "[^a]", "\\d", "\\w", "\\s", "a", "b", "x"]);
  if (r < 9) { ctx.groups++; return "(" + genAlt(depth + 1, ctx) + ")"; }
  if (r < 11) return "(?:" + genAlt(depth + 1, ctx) + ")";
  if (r < 12 && ctx.groups > 0) return "\\" + (1 + rnd(ctx.groups));
  if (r < 13) return "(?=" + genAlt(depth + 1, ctx) + ")";
  if (r < 14) return "(?!" + genAlt(depth + 1, ctx) + ")";
  if (r < 15) return "(?<=" + genAlt(depth + 1, ctx) + ")";
  if (r < 16) return "(?<!" + genAlt(depth + 1, ctx) + ")";
  if (r < 17) return pick(["^", "$", "\\b", "\\B"]);
  if (r < 18) { ctx.groups++; ctx.names++; return "(?<n" + ctx.names + ">" + genAlt(depth + 1, ctx) + ")"; }
  if (r < 19 && ctx.names > 0) return "\\k<n" + (1 + rnd(ctx.names)) + ">";
  return pick(["[a-c]", "[^bc]", "[\\w ]", "[^\\s]"]);
}
function genTerm(depth, ctx) {
  let a = genAtom(depth, ctx);
  if (/^(\^|\$|\\b|\\B|\(\?<[=!])/.test(a)) return a;
  const q = rnd(10);
  if (q < 5) return a;
  a += pick(["*", "+", "?", "{2}", "{1,2}", "{0,1}", "{2,}", "*?", "+?", "??"]);
  return a;
}
function genSeq(depth, ctx) { const n = 1 + rnd(3); let s = ""; for (let i = 0; i < n; i++) s += genTerm(depth, ctx); return s; }
function genAlt(depth, ctx) { const n = rnd(3) === 0 ? 2 : 1; const parts = []; for (let i = 0; i < n; i++) parts.push(rnd(8) === 0 ? "" : genSeq(depth, ctx)); return parts.join("|"); }
function genInput() { const n = rnd(9); let s = ""; const alpha = ["a", "b", "c", "a", "b", "a", " ", "1", "\n", "A"]; for (let i = 0; i < n; i++) s += pick(alpha); return s; }
for (let i = 0; i < NRANDOM; i++) {
  const ctx = { groups: 0, names: 0 };
  const p = genAlt(0, ctx);
  const f = pick(["", "", "", "i", "m", "s", "u", "iu", "ms"]);
  add(p, f, genInput(), rnd(3) === 0 ? rnd(4) : 0);
}

// ---- run ----
build();
const hex = (s) => { let o = ""; for (let i = 0; i < s.length; i++) o += s.charCodeAt(i).toString(16).padStart(4, "0"); return o; };
const lines = cases.map(([p, f, i, s]) => `${hex(p)}\t${f}\t${hex(i)}\t${s}`).join("\n") + "\n";
const dump = opt("--dump", null);
if (dump) { (await import("node:fs")).writeFileSync(dump, lines); console.log(`${cases.length} cases written`); process.exit(0); }
const run = spawnSync(cli, [], { input: lines, encoding: "utf8", maxBuffer: 1 << 28 });
if (run.status !== 0) { console.error("rx_cli failed:", run.status, run.signal, run.stderr); }
const got = run.stdout.split("\n");
const reason = (m) => m.replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, "");
function v8(p, f, input, start) {
  let re;
  try { re = new RegExp(p, f.replace(/[gyd]/g, "") + "gd" + (f.includes("y") ? "y" : "")); } catch (e) { return "ERR " + reason(e.message); }
  re.lastIndex = start;
  let m;
  try { m = re.exec(input); } catch (e) { return "THROW " + e.constructor.name; }
  if (!m) return "null";
  return JSON.stringify(m.indices.map((x) => (x ? [x[0], x[1]] : null)));
}
let fails = 0, shown = 0;
const show = (s) => JSON.stringify(s);
for (let k = 0; k < cases.length; k++) {
  const [p, f, i, s] = cases[k];
  const exp = v8(p, f, i, s);
  const act = got[k] ?? "<missing>";
  if (exp !== act) {
    fails++;
    if (shown < SHOW) { shown++; console.log(`DIFF /${p}/${f} on ${show(i)} from ${s}: V8 ${exp} | rx ${act}`); }
  }
}
console.log(`${cases.length} cases, ${fails} differ`);
process.exit(fails ? 1 : 0);
