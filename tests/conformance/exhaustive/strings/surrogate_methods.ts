// Broad surrogate-pair / multibyte string-method coverage. `.length`, indexing
// and slice operate on UTF-16 code units (and may split a surrogate pair), while
// iteration (for-of / spread / Array.from) yields whole code points. Exercises
// astral-plane characters, ZWJ sequences, regional-indicator flags, skin-tone
// modifiers, combining marks, lone surrogates, and CJK across the method matrix.
function main(): void {
  // length: code units vs code points
  console.log("😀".length, "𝕏".length, "日本語".length, "café".length); // 2 2 3 4
  console.log("a😀b".length, [..."a😀b"].length);                        // 4 3

  // ZWJ family / flag / skin tone: many code units, fewer code points
  const fam = "👨‍👩‍👧‍👦";
  console.log(fam.length, [...fam].length);   // 11 7
  const flag = "🇯🇵";
  console.log(flag.length, [...flag].length); // 4 2
  const wave = "👋🏽";
  console.log(wave.length, [...wave].length, wave.codePointAt(0)); // 4 2 128075

  // indexing / charCodeAt / codePointAt / at
  console.log("日本語".charAt(1), "😀".charCodeAt(0), "😀".charCodeAt(1)); // 本 55357 56832
  console.log("a😀".codePointAt(1), "café".at(-1), "😀x".at(-1));        // 128512 é x

  // slice / substring may split a pair; iteration keeps pairs whole
  console.log("😀😁😂".slice(0, 2), "😀😁😂".slice(2));   // 😀 😁😂
  console.log("a😀b".slice(0, 2).length, "x😀y".substring(1, 3).length); // 2 2

  // lone surrogate from a split pair
  const half = "😀".slice(0, 1);
  console.log(half.length, half.charCodeAt(0) === 0xd83d); // 1 true
  console.log("😀".split("").length, "😀".split("")[0].charCodeAt(0) === 0xd83d); // 2 true

  // search across multibyte
  console.log("日本語日本".indexOf("日本"), "日本語日本".lastIndexOf("日本")); // 0 3
  console.log("x😀y😀".indexOf("😀"), "x😀y😀".lastIndexOf("😀"));           // 1 4
  console.log("café".includes("é"), "日本".startsWith("日"), "abc😀".endsWith("😀")); // true true true

  // iteration: for-of yields code points
  let cps: number[] = [];
  for (const c of "A😀あ") cps.push(c.codePointAt(0)!);
  console.log(cps.join(",")); // 65,128512,12354
  console.log([..."a😀b"].reverse().join("")); // b😀a (code-point reverse)
  console.log(Array.from("😀😁").length, Array.from("日本").join("|")); // 2 日|本

  // split / replace
  console.log(JSON.stringify("a日b日c".split("日")));        // ["a","b","c"]
  console.log("日本語日本".replaceAll("日本", "X"));          // X語X
  console.log("日1本2".replace(/\d/g, (m: string) => "[" + m + "]")); // 日[1]本[2]
  console.log("日本語".split("").length);                    // 3

  // case (ligature / sharp-s expansion)
  console.log("café".toUpperCase(), "ß".toUpperCase(), "ﬁ".toUpperCase()); // CAFÉ SS FI
  console.log("ÀÉÎ".toLowerCase()); // àéî

  // pad / repeat with multibyte fill
  console.log("5".padStart(3, "日"), "ab".padStart(6, "😀").length); // 日日5 6
  console.log("日本".repeat(3), "😀".repeat(2).length);              // 日本日本日本 4

  // trim / normalize / fromCodePoint
  console.log("  日本  ".trim(), "\t😀\n".trim());                    // 日本 😀
  console.log("é".normalize("NFD").length, "ﬁ".normalize("NFKC"));    // 2 fi
  console.log(String.fromCodePoint(0x1f600).length, String.fromCodePoint(0x65e5, 0x672c)); // 2 日本

  // multibyte as Map / Set / object keys
  const m = new Map<string, number>();
  m.set("日本", 1); m.set("😀", 2);
  console.log(m.get("日本"), m.get("😀"), m.size); // 1 2 2
  console.log(new Set(["😀", "😀", "日本"]).size); // 2
  const o: any = { 日本: 1 };
  o["😀"] = 2;
  console.log(o.日本, o["😀"], Object.keys(o).join(",")); // 1 2 日本,😀

  // matchAll / search / sort
  console.log([..."a1b2".matchAll(/\d/g)].length, "abc日".search(/日/)); // 2 3
  console.log(["猫", "犬", "鳥"].sort().join(",")); // 犬,猫,鳥

  // template + JSON of multibyte
  const n = "世界";
  console.log(`こんにちは、${n}！😀`);
  console.log(JSON.stringify({ 名前: "日本", e: "😀" }), JSON.parse('"日本😀"').length); // {"名前":"日本","e":"😀"} 5
}
main();
