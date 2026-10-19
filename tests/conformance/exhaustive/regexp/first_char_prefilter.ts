// First-character prefilter of the regexp adapter: a pattern whose matches
// must start with a unit from a small set runs the engine only at candidate
// positions. Every form the analysis accepts or declines must behave exactly
// as the full engine: classes (negated, ranges, escapes), alternations with
// anchors, groups, quantifiers, flags, UTF-16 inputs, lastIndex and every
// entry point (test, exec, match, matchAll, replace, split, search).
function show(label: string, re: RegExp, inputs: string[]): void {
  const out: string[] = [];
  for (const s of inputs) {
    re.lastIndex = 0;
    const t = re.test(s);
    const after = re.lastIndex;
    re.lastIndex = 0;
    const m = s.match(re);
    const idx = s.search(re);
    const rep = s.replace(re, (x) => "<" + x + ">");
    out.push((t ? "T" : "F") + after + ":" + idx + ":" + (m ? m.join("|") : "-") + ":" + rep);
  }
  console.log(label, out.join(" # "));
}
function main(): void {
  const paths = ["/users/kaz/project/src/compiler/checker.ts", "C:/Users/Kaz/Project/File.TS", "mixed Case With Spaces", "lower_only-path.d.ts", "", "ALLUPPER", "ab\u00dfc\u0130d\u0131e", "x\u00c0y\u0100z"];
  show("lower", /[^\u0130\u0131\u00DFa-z0-9\\/:\-_. ]+/g, paths);
  const rel = ["a/b/c", "a//b", "./a", "../a", "a/./b", "a/../b", "a/.", "a/..", ".", "..", "...", "a/...b", "/", "", ".a", "a.", "/./"];
  show("segment", /\/\/|(?:^|\/)\.\.?(?:$|\/)/, rel);
  const words = ["the Quick brown Fox Jumps 12 times", "no caps here 7", "ABC", "", "9", "end Z"];
  show("digits", /\d+/g, words);
  show("caps", /[A-Z][a-z]*/g, words);
  show("digit-or-cap", /(?:\d|[A-Z])+/g, words);
  show("escape-slash", /\/\.\.?(?:$|\/)/, rel);
  show("hex-escapes", /[\x41-\x43]|\u0046/g, words);
  show("named-group", /(?<cap>[A-Z])(?<rest>[a-z]+)/g, words);
  show("brace-min", /[A-Z]{2,}/g, words);
  show("lazy-plus", /[0-9]+?/g, words);
  show("word-class", /\W+/g, words);
  show("not-digit", /\D{3}/g, words);
  show("space", /\s[a-z]/g, words);
  show("class-escape-range", /[\d_]+/g, ["a_1 b22 __"]);
  show("class-dash", /[-A-Z]+/g, ["x-Y-Z-w"]);
  show("neg-class-wide", /[^a-z ]/g, ["abc \u00e9 \u0100 DEF"]);
  // forms the analysis declines: the full engine must still win
  show("dot-first", /.x/g, words);
  show("nullable-star", /[A-Z]*x/g, ["ABx", "x", "no"]);
  show("optional-first", /Q?u/g, words);
  show("empty-alt", /Z|/g, ["aZ"]);
  show("boundary", /\bQ/g, words);
  show("backref", /(a)\1/g, ["aa ab aaa"]);
  show("lookahead", /(?=Q)Q/g, words);
  show("ignorecase", /q[a-z]+/gi, words);
  show("multiline", /^[a-z]+/gm, ["ab\ncd\nEF"]);
  show("sticky", /[A-Z]/y, ["xA", "Ax"]);
  show("unicode", /[\u{1F600}]/gu, ["a\u{1F600}b"]);
  show("dollar-first", /$/g, ["ab"]);
  show("brace-zero", /[A-Z]{0,2}x/g, ["ABx x"]);
  // entry points over a global prefilter regexp
  const re = /[A-Z]+/g;
  const text = "aBCdEfGHIj";
  console.log(text.split(re).join(","), text.split(/[A-Z]/).length, [...text.matchAll(re)].map((m) => m[0] + "@" + m.index).join(","));
  let m: RegExpExecArray | null;
  const found: string[] = [];
  while ((m = re.exec(text)) !== null) found.push(m[0] + "@" + m.index + "/" + re.lastIndex);
  console.log(found.join(","), re.lastIndex);
  re.lastIndex = 5;
  console.log(re.test(text), re.lastIndex, re.test(text), re.lastIndex, re.test(text), re.lastIndex);
  console.log("x".repeat(50).replace(/X/g, "-").length, ("a".repeat(30) + "B").replace(/[A-Z]/g, "+"), "no-upper".replace(/[A-Z]+/, "?"));
  // a UTF-16 input through the same regexps
  const wide = "\u3042\u3044 ABC \u3046 def 12";
  console.log(wide.replace(/[A-Z]+/g, "#"), wide.search(/\d/), wide.match(/[^a-z \u3042-\u3046]+/g)!.join("|"), /\/\/|(?:^|\/)\.\.?(?:$|\/)/.test(wide + "/../x"));
  // collection pressure while scanning
  let hits = 0;
  for (let i = 0; i < 4000; i++) {
    const s = "path/to/file" + i + (i % 7 === 0 ? "/../up" : "") + (i % 11 === 0 ? "/CAPS" : "");
    if (/\/\/|(?:^|\/)\.\.?(?:$|\/)/.test(s)) hits++;
    if (/[^\u0130\u0131\u00DFa-z0-9\\/:\-_. ]+/g.test(s)) hits += 10;
  }
  console.log(hits);
}
main();
