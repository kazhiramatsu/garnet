function main(): void {
  const composed = "\u00e9";
  const decomposed = "e\u0301";
  console.log(decomposed.normalize(), decomposed.normalize("NFC"));
  console.log(composed.normalize("NFD").length, composed.normalize("NFD").charCodeAt(1));

  console.log("\u212b".normalize("NFC").charCodeAt(0));
  console.log("\ufb03".normalize("NFKD"));

  const pair = "\uD83D\uDE00";
  const lone = "\uD800";
  console.log(pair.normalize("NFC").length, pair.normalize("NFC").codePointAt(0));
  console.log(lone.normalize("NFC").length, lone.normalize("NFC").charCodeAt(0));

  const fn = String.prototype.normalize;
  console.log(fn.call(decomposed, "NFC"));

  try {
    console.log("x".normalize("BAD"));
  } catch (e: any) {
    console.log(e.name, e.message.indexOf("normalization") >= 0);
  }
}

main();
