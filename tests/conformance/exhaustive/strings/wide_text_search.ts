// Searches and UTF-8 lengths of texts stored as UTF-16 (one character past U+00FF is enough). The
// runtime reads such a text sixteen bytes at a time: the answers must not depend on where a match
// lies in a block of 8 or 32 units, on a needle that starts in one block and ends in the next, on a
// match at the very end, or on a surrogate pair split by a block.
function mix(h: number, v: number): number {
  return (Math.imul(h ^ (v + 0x9e3779b9), 0x01000193) >>> 0) % 1000000007;
}

function main(): void {
  const wide = "中";
  // one unit at every position of texts of every length up to 140
  let h = 7;
  for (let n = 1; n <= 140; n++) {
    for (let at = 0; at < n; at += n < 40 ? 1 : 3) {
      const text = wide + "a".repeat(at) + "\n" + "a".repeat(n - at - 1);
      h = mix(h, text.indexOf("\n"));
      h = mix(h, text.indexOf("\n", at + 1));
      h = mix(h, text.indexOf("\n", at + 2));
      h = mix(h, text.indexOf("\r"));
      h = mix(h, text.indexOf(wide));
      h = mix(h, text.indexOf(wide, 1));
      h = mix(h, text.includes("\n") ? 1 : 0);
    }
  }
  console.log("one unit", h);

  // a needle of two to seven units, its first unit and its first two units strewn before it
  h = 11;
  const needles = ["im", "imp", "import", "require", "*/", "\r\n", wide + wide, "t" + wide + "x"];
  for (const needle of needles) {
    for (let n = 0; n <= 90; n += n < 34 ? 1 : 7) {
      const decoys = (needle[0]! + "q").repeat(n >> 1) + needle.slice(0, 2) + "z";
      const text = wide + decoys + needle + "tail";
      const at = text.indexOf(needle);
      h = mix(h, at);
      h = mix(h, text.indexOf(needle, at + 1));
      h = mix(h, (wide + decoys + needle).indexOf(needle));                 // ends with the text
      h = mix(h, (wide + decoys + needle.slice(0, needle.length - 1)).indexOf(needle));   // one unit short
      h = mix(h, text.lastIndexOf(needle));
      h = mix(h, text.split(needle).length);
    }
  }
  console.log("needles", h);

  // every line break of a long text, as a compiler collects its line starts
  let source = "// " + wide + "\n";
  for (let i = 0; i < 4000; i++) source += "  const v" + i + " = import_" + (i % 7) + "(" + i + ");" + (i % 97 === 0 ? "\r\n" : "\n");
  let lines = 0;
  let sum = 0;
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) { lines++; sum = (sum + i) % 1000003; }
  let imports = 0;
  for (let i = source.indexOf("import"); i >= 0; i = source.indexOf("import", i + 6)) imports++;
  console.log("source", source.length, lines, sum, imports, source.indexOf("\r"), source.indexOf(" "), source.indexOf("require"));

  // UTF-8 lengths: one, two and three byte units and pairs, at every offset of a block
  h = 13;
  const parts = ["a", "é", "中", "😀", "\ud83d", "\ude00", "\ud83dx", "߿", "ࠀ", "￿", "\u007f", "\u0080"];
  for (let pad = 0; pad < 20; pad++) {
    for (const p of parts) {
      const text = wide + "b".repeat(pad) + p + "c".repeat(pad % 5) + p;
      h = mix(h, Buffer.byteLength(text, "utf8"));
      h = mix(h, Buffer.byteLength(text + text + p, "utf8"));
    }
  }
  console.log("utf8", h, Buffer.byteLength(source, "utf8"), Buffer.byteLength(source + "\ud83d", "utf8"), Buffer.byteLength("\ude00" + source, "utf8"));
  const long = (wide + "xé😀y").repeat(1000);
  console.log("long", long.length, Buffer.byteLength(long, "utf8"), Buffer.from(long, "utf8").length, long.indexOf("\ude00y" + wide, 4000), long.indexOf("z"));
}
main();
