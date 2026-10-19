// Patterns anchored at the start (`^` without the m flag and without a
// top-level alternation) try only position 0; everything else keeps the
// search. Alternation, classes and escapes containing `|`, multiline,
// sticky, global iteration, empty matches, split/replace/matchAll.
function main(): void {
  const text = "#!/usr/bin/env node\nconst x = 1;\n";
  const plain = "const y = 2;\n#!/not/a/shebang\n";
  console.log(/^#!.*/.test(text), /^#!.*/.test(plain), /^#!.*/.exec(text)?.[0], /^#!.*/.exec(plain));
  console.log(text.match(/^#!.*/)?.[0], plain.match(/^#!.*/), text.search(/^c/), plain.search(/^c/));
  // alternation at the top level is not anchored as a whole
  console.log(/^a|b/.test("xxb"), /^a|b/.exec("xxb")?.index, /^(a|b)/.test("xxb"), /^(a|b)/.test("bxx"));
  console.log(/^[|x]/.test("|a"), /^[|x]/.test("a|"), /^a\|b/.test("a|b"), /^a\|b/.test("xa|b"));
  // multiline and sticky
  console.log(/^ab/m.test("x\nab"), /^ab/.test("x\nab"), "x\nab\nab".match(/^ab/gm)?.length);
  const y = /^ab/y; y.lastIndex = 2; console.log(y.test("xxab"), y.lastIndex); y.lastIndex = 0; console.log(y.test("abab"), y.lastIndex);
  // global iteration: an anchored global pattern matches once
  const g = /^a/g;
  console.log("aaa".match(g), "aaa".replace(g, "-"), [..."aaa".matchAll(/^a/g)].length, g.lastIndex);
  console.log("aaa".replace(/^a/, "-"), "aaa".replace(/a/g, "-"), "aaa".replace(/^/g, "-"), "abc".replace(/^/, "-"));
  // split with anchored patterns (sticky matching per position)
  console.log(JSON.stringify("a,b,c".split(/^,/)), JSON.stringify("a,b,c".split(/,/)), JSON.stringify("abc".split(/^/)), JSON.stringify("abc".split(/^a/)));
  // flags i and u, lookahead, empty pattern, dot and escapes at the start
  console.log(/^A/i.test("abc"), /^A/i.test("bac"), /^\u{1F600}/u.test("\u{1F600}x"), /^(?=a)/.test("abc"), /^(?=a)/.test("bbc"));
  console.log(/^\d+/.exec("123x")?.[0], /^\d+/.exec("x123"), /^.$/.test("a"), /^.$/.test("ab"), /^$/.test(""), /^$/.test("a"));
  // exec from a non-zero lastIndex on a global anchored pattern
  const g2 = /^x/g; g2.lastIndex = 1; console.log(g2.exec("xx"), g2.lastIndex); g2.lastIndex = 0; console.log(g2.exec("xx")?.index, g2.lastIndex);
  // a large input: the anchored test must not scan it
  let big = "";
  for (let i = 0; i < 200000; i++) big += "line " + i + "\n";
  let hits = 0;
  for (let r = 0; r < 200; r++) { if (/^#!.*/.test(big)) hits++; if (/^line 0/.test(big)) hits++; }
  console.log(hits, big.length);
}
main();
