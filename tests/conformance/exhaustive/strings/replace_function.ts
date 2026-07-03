// String.replace / replaceAll accept a FUNCTION replacer, called per match with
// (matched, offset, wholeString) and whose ToString'd return value is the
// replacement. (For a literal-string pattern there are no capture groups, so the
// args are exactly matched/offset/string.) Previously tsaot silently treated a
// function replacer as a no-op (returned the input unchanged).
function main(): void {
  // basic: transform the matched substring
  console.log("abc".replace("b", (m: string) => m.toUpperCase())); // aBc
  console.log("aaa".replaceAll("a", (m: string) => m.toUpperCase())); // AAA

  // offset and whole-string arguments
  console.log("hello".replace("l", (m: string, o: number) => `[${o}]`)); // he[2]lo
  console.log("hello".replace("ll", (m: string, o: number, s: string) => `<${m},${o},${s}>`)); // he<ll,2,hello>o
  console.log("a.b.c".replaceAll(".", (m: string, o: number) => `${o}`)); // a1b3c

  // replace only affects the first match; replaceAll all matches
  let n = 0;
  const r = "abcabc".replace("b", (m: string) => { n++; return "X"; });
  console.log(r, n); // aXcabc 1
  let n2 = 0;
  const r2 = "abcabc".replaceAll("b", (m: string) => { n2++; return "X"; });
  console.log(r2, n2); // aXcaXc 2

  // no match -> function never called, input unchanged
  let n3 = 0;
  console.log("abc".replace("z", (m: string) => { n3++; return "Q"; }), n3); // abc 0

  // return value is ToString'd (non-string returns coerce)
  console.log("x5y".replace("5", (m: string) => Number(m) * 2 as any)); // x10y
  console.log("a1b".replace("1", () => 42 as any));                     // a42b

  // multi-char pattern, matched substring passed through
  console.log("foobarfoo".replaceAll("foo", (m: string) => `${m.length}`)); // 3bar3

  // closure capture inside the replacer
  const suffix = "!";
  console.log("hi".replace("i", (m: string) => m + suffix)); // hi!  -> "h" + "i!" = "hi!"

  // empty pattern: function invoked with matched="" at each position
  console.log("ab".replace("", (m: string, o: number) => `[${o}]`));     // [0]ab
  console.log("ab".replaceAll("", (m: string, o: number) => `${o}`));    // 0a1b2

  // regressions: string replacer and $ patterns unchanged
  console.log("abc".replace("b", "X"));        // aXc
  console.log("abc".replace("b", "[$&]"));      // a[b]c
  console.log("aXbXc".replaceAll("X", "-"));    // a-b-c
}

main();
