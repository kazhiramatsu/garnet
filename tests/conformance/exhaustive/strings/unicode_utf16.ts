function main(): void {
  const latin = "é";
  console.log(latin.length, latin.charCodeAt(0), latin.indexOf("é"), latin.slice(0, 1));

  const face = "😀";
  console.log(face.length, face.charCodeAt(0), face.charCodeAt(1), face.codePointAt(0));

  const mixed = "a😀éZ";
  console.log(mixed.length, mixed.indexOf("😀"), mixed.indexOf("é"), mixed.charCodeAt(3));
  console.log(mixed.startsWith("a😀"), mixed.endsWith("éZ"), mixed.includes("😀é"));
  console.log(mixed.slice(1, 3).length, mixed.slice(1, 3).codePointAt(0));

  const parts = "é-😀-é".split("-");
  console.log(parts.length, parts[0], parts[1].length, parts[1].codePointAt(0), parts[2]);

  console.log("éé".replaceAll("é", "x"), "a😀b".replace("😀", "Q"));

  const cp = String.fromCodePoint(0x1f600);
  const cc = String.fromCharCode(0xd83d, 0xde00);
  console.log(cp.length, cp.codePointAt(0), cc.length, cc.codePointAt(0));

  const parsed = JSON.parse('"é😀"');
  console.log(JSON.stringify("é😀"), parsed.length, parsed.codePointAt(1));
}

main();
