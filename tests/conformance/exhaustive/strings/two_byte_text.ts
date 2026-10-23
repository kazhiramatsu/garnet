// A text with one character beyond Latin-1 is stored two bytes a unit: the
// code-unit reads, searches and prefix tests that a scanner runs over it,
// against one-byte needles and texts the other way round.
function lineStarts(text: string): number[] {
  const out: number[] = [0];
  for (let pos = 0; pos < text.length; pos++) {
    const ch = text.charCodeAt(pos);
    if (ch === 13 && text.charCodeAt(pos + 1) === 10) pos++;
    if (ch === 13 || ch === 10 || ch === 0x2028) out.push(pos + 1);
  }
  return out;
}
function main() {
  let text = "// ✓ a two-byte text\n";
  for (let i = 0; i < 30; i++) text += "const v" + i + " = \"αβγ\"; /* note " + i + " */ x = y;\r\n";
  text += "end";
  const out: unknown[] = [text.length, lineStarts(text).length, lineStarts(text).slice(0, 4).join(","), lineStarts(text).slice(-2).join(",")];
  out.push(text.charCodeAt(3), text.charCodeAt(text.length - 1), text.charCodeAt(text.length), text.charCodeAt(-1), text.charCodeAt(1.7), text.charCodeAt(NaN));
  let pos = 0, n = 0;
  const closes: number[] = [];
  while ((pos = text.indexOf("/*", pos)) >= 0) { const c = text.indexOf("*/", pos); closes.push(c); pos = c + 2; n++; }
  out.push(n, closes.slice(0, 3).join(","), text.indexOf("\n"), text.indexOf("\r\n"), text.lastIndexOf("\r\n"), text.lastIndexOf("/*"), text.indexOf("zz"), text.indexOf("αβγ"), text.indexOf("γ\"", 40), text.indexOf("✓"), text.lastIndexOf("✓"), text.indexOf("✗"));
  out.push(text.startsWith("// ✓"), text.startsWith("const", 22), text.startsWith("const v1 ", 22), text.endsWith("end"), text.endsWith("ends"), text.includes("x = y"), text.includes("x = z"));
  const names = ["const", "v12", "note", "x", "ζ", "αβγ", "v1 = \"αβγ\"; /* note 1 */ x = y;"];
  const found: number[] = [];
  for (const nm of names) found.push(text.indexOf(nm), text.indexOf(nm, 100), text.lastIndexOf(nm));
  out.push(found.join(","));
  // the other way round: a one-byte text searched with two-byte needles
  const ascii = "plain ascii text with notes /* a */ and /* b */ end";
  out.push(ascii.indexOf("✓"), ascii.indexOf("a ✓"), ascii.lastIndexOf("✓"), ascii.includes("✓"), ascii.startsWith("✓"), ascii.indexOf("é"), ascii.indexOf("*/"), ascii.lastIndexOf("*/"));
  const latin = "café au lait";
  out.push(latin.indexOf("é"), latin.indexOf("é au"), latin.charCodeAt(3), ("x" + latin + "Ω").indexOf("é au"), ("x" + latin + "Ω").lastIndexOf("é"), ("x" + latin + "Ω").indexOf("Ω"));
  const long = "αβγ".repeat(20) + "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" + "αβγ".repeat(5);
  out.push(long.indexOf("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ"), long.indexOf("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK"), long.lastIndexOf("stuvwxyz0123456789ABCDEFGHIJ"), long.indexOf("0123456789ABCDEFGHIJαβγ"));
  const sliced = text.slice(22, 400);
  out.push(sliced.indexOf("*/"), sliced.charCodeAt(0), sliced.charCodeAt(13), sliced.lastIndexOf("\n"), sliced.startsWith("const"), sliced.includes("αβγ"));
  console.log(JSON.stringify(out));
}
main();
