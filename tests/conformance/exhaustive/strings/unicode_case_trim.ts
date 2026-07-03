function main(): void {
  const ws = "\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  console.log((ws + "x" + ws).trim());
  console.log(("\u00a0\u3000x\u00a0").trimStart().charCodeAt(0), ("x\u00a0\u3000").trimEnd().length);
  console.log((" \u00a0x\u3000 ").trimLeft(), (" \u00a0x\u3000 ").trimRight());

  console.log("éåñøþÿ".toUpperCase());
  console.log("ÉÅÑØÞŸ".toLowerCase());
  console.log("straße".toUpperCase(), "ẞ".toLowerCase());
  const dotted = "İ".toLowerCase();
  console.log(dotted.length, dotted.charCodeAt(0), dotted.charCodeAt(1));
  console.log("ı".toUpperCase(), "µ".toUpperCase());
  console.log("ΟΣ ΣΣ Σ".toLowerCase(), "σς".toUpperCase());
  console.log("привет ё".toUpperCase(), "ПРИВЕТ Ё".toLowerCase());
  console.log("ﬃ".toUpperCase());

  const any: any = "\u00a0éß\u3000";
  console.log(any.trim().toUpperCase());
  console.log(any.trimLeft().length, any.trimRight().length);
}
main();
