// RegExp replace results built in one buffer (ts_sb_*): $-patterns, function
// replacers, named groups, UTF-16, long inputs; the compiler's toFileNameLowerCase.
const lowerRe = /[^İıßa-z0-9\\/:\-_. ]+/g;
function toLower(x: string): string { return lowerRe.test(x) ? x.replace(lowerRe, (s) => s.toLowerCase()) : x; }
function main(): void {
  const out: string[] = [];
  out.push(toLower("/Users/Kaz/Dev/Garnet/SRC/index.TS"), toLower("/already/lower.ts"), toLower("ÄÖÜ/ß/İ"));
  out.push("a-b-c".replace(/-/g, "$$"), "abc".replace(/b/, "[$&|$`|$']"), "2026-10-20".replace(/(\d+)-(\d+)-(\d+)/, "$3/$2/$1"));
  out.push("x1y22z333".replace(/(?<n>\d+)/g, "<$<n>>"), "日本語テキスト".replace(/本/g, "\u{1F600}"), "aaa".replace(/a/g, (m, i) => String(i)));
  out.push("long ".repeat(50).replace(/o/g, "0").length.toString(), "no match".replace(/zz/g, "!"), "$1 literal".replace(/literal/, "$9$0$"));
  let s = 0;
  for (let i = 0; i < 20000; i++) s += toLower("/Users/Kaz/proj" + (i % 100) + "/File" + (i % 7) + ".TS").length;
  out.push(String(s));
  console.log(out.join(" | "));
}
main();
