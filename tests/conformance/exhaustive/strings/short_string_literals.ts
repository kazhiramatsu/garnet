// String literals of up to five ASCII units against strings made at run time: equality and identity with
// characters read out of a source string, a switch on one-character labels (with a non-ASCII and a long
// label among them), the empty string, concatenation that produces a short string, property keys and
// Map keys from short literals, JSON round trips, typeof, length, and comparisons of short against long.
function kind(ch: string | undefined): string {
  switch (ch) {
    case undefined: return "end";
    case " ": case "\t": return "ws";
    case "\n": return "nl";
    case "é": return "e-acute";
    case "abcdef": return "long";
    case "#": return "hash";
    default: return "other";
  }
}
function main(): void {
  const out: string[] = [];
  const src = "a #\tb\né abcdef";
  const kinds: string[] = [];
  for (let i = 0; i <= src.length; i++) kinds.push(kind(src[i]));
  out.push(kinds.join(","));
  const ab = "a" + "b", abc = ab + "c", abcde = abc + "de", abcdef = abcde + "f";
  out.push(String(ab === "ab"), String(abc === "abc"), String(abcde === "abcde"), String(abcdef === "abcdef"), String(abcdef.slice(0, 5) === "abcde"), String(abcdef.slice(0, 5) === abcde));
  out.push(String("" === src.slice(0, 0)), String("" === ""), String("".length), String(typeof "ab"), String("ab".length), String("ab" < "b"), String("b" > "ab"), String("ab" === ("a" + "b")), String(ab !== "ba"));
  const o: Record<string, number> = { a: 1, bc: 2, def: 3 };
  const k1 = "a", k2 = "b" + "c";
  out.push(String(o[k1]), String(o[k2]), String(o["def"]), Object.keys(o).join(""), String("a" in o), String("bc" in o));
  const m = new Map<string, number>([["x", 1], ["yz", 2]]);
  out.push(String(m.get("x")), String(m.get("y" + "z")), String(m.has(src[0])), String([..."hey"].map((c) => c === "e").join(",")));
  out.push(JSON.stringify({ s: "ab", t: "", u: "\n" }), JSON.parse('"ok"') === "ok" ? "same" : "diff", String(["b", "a", "ab"].sort().join("|")), String("ab".charAt(1) === "b"), String("é" === "é"), String("é".length));
  const s5 = "hello", s6 = "hello!";
  out.push(String(s5 === "hello"), String(s6 === "hello!"), String(s5 + "!" === s6), String(`${s5}` === "hello"), String(s5.toUpperCase()), String(s5.indexOf("l")), String("x".repeat(3)), String("ab".padStart(5, "-")));
  console.log(out.join("\n"));
}
main();
