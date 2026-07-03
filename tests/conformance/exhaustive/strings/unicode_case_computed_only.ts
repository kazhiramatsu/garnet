function main(): void {
  const upperKey: any = "toUpperCase";
  const lowerKey: any = "toLowerCase";
  const s: any = "\u0390";
  const upper = s[upperKey]();
  console.log(upper.length, upper.charCodeAt(0), upper.charCodeAt(1), upper.charCodeAt(2));

  const sigma: any = "ΟΣ";
  console.log(sigma[lowerKey]());

  const normalizeKey: any = "normalize";
  const decomposed: any = "e\u0301";
  console.log(decomposed[normalizeKey]("NFC"));
}

main();
