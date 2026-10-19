// Strings, second round: strict equality with an inline length check, static
// literals boxed in line, `string + integer` at builder size without a
// temporary number string, cached hashes on view strings, and the numeric
// fast path of relational comparison. Every observable result must match V8.
function main(): void {
  // strict equality: short vs heap, equal and different lengths, views vs flat
  const text = "identifier_one identifier_two this that document describe";
  const words = text.split(" ");
  const views = [text.substring(0, 14), text.substring(15, 29), text.substring(30, 34), text.substring(35, 39), text.substring(40, 48), text.substring(49, 57)];
  let eq = 0, neq = 0;
  for (const a of words) for (const b of views) { if (a === b) eq++; else neq++; }
  console.log(eq, neq);
  function classify(name: string): number {
    switch (name) {
      case "document": case "console": return 1;
      case "$": return 2;
      case "beforeEach": case "describe": case "suite": case "it": return 3;
      case "this": return 4;
      case "identifier_one": return 5;
      default: return 0;
    }
  }
  console.log(views.map(classify).join(","), classify("x"), classify("identifier_two"), classify(""));
  const built = "ident" + "ifier_one";
  const lit: string[] = ["abcdefgh", "abcdefgi", "ab", "abc"];
  console.log(built === "identifier_one", views[0] === built, lit[0] === lit[1], lit[2] === "ab", lit[2] === lit[3]);
  const nonAscii = "日本語の識別子";
  console.log(nonAscii === "日本語の識別子", nonAscii.substring(0, 3) === "日本語", nonAscii.substring(0, 3) === "日本", nonAscii.length);
  // string + integer at and above the builder threshold (24 code units)
  let key = "";
  for (let i = 0; i < 40; i++) { if (key.length) key += ","; key += 1000 + i * 7; if (i % 5 === 0) key += ":" + (i + 2); }
  console.log(key, key.length);
  let s = "prefix-of-twenty-four!!";
  s += 5; console.log(s, s.length);
  s += 123456789; console.log(s);
  s += -42; console.log(s);
  s += 1.5; console.log(s);
  s += 9007199254740993; console.log(s);
  s += NaN; s += Infinity; s += -0; console.log(s);
  console.log(5 + s.substring(0, 30), -7 + "x".repeat(30), 12345 + "y".repeat(23));
  const saved = s; s += 1; console.log(saved === s, saved.length, s.length, s.endsWith("1"), s.substring(0, saved.length) === saved);
  const t = key + 7; const u = key + 8; console.log(t === u, t.length, u.length, t.substring(0, key.length) === u.substring(0, key.length));
  const base = "0123456789012345678901234";
  const b1 = base + 1, b2 = base + 2; console.log(b1, b2, b1 === b2, base + 3);
  const wide = "日本語の識別子日本語の識別子日本語の識別子"; const w1 = wide + 42; console.log(w1, w1.length, w1 + 7);
  // view hashes as Map keys and comparisons after Map use
  const m = new Map<string, number>();
  for (let i = 0; i < words.length; i++) m.set(views[i], i);
  console.log(words.map((w) => m.get(w)).join(","), m.get(views[2]), m.get("this"), m.has(text.substring(40, 48)));
  const sub = text.substring(15, 29);
  m.set(sub, 99); console.log(m.get("identifier_two"), m.size, sub === "identifier_two", views[1] === sub);
  // relational: numbers (NaN, -0, infinities), strings, mixed
  const nums = [1, 2, NaN, -0, 0, Infinity, -Infinity, 1.5];
  const rel: string[] = [];
  for (const a of nums) for (const b of nums) rel.push((a < b ? "<" : "") + (a <= b ? "=" : "") + (a > b ? ">" : "") + (a >= b ? "}" : ""));
  console.log(rel.join("|"));
  const mixed: any[] = [1, "2", "10", "abc", "abd", null, undefined, true, [3], {}];
  const rel2: string[] = [];
  for (const a of mixed) for (const b of mixed) rel2.push((a < b ? "<" : ".") + (a >= b ? ">" : "."));
  console.log(rel2.join(""));
  // literals under collection pressure keep their identity and content
  let hits = 0;
  for (let i = 0; i < 20000; i++) {
    const junk = { i, s: "junk" + i };
    const w = words[i % words.length];
    if (classify(w) === 1 || w === "describe" || junk.s === "junk5") hits++;
  }
  console.log(hits);
}
main();
