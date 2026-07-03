function main(): void {
  console.log("abcabc".replace(/b/, "X"));
  console.log("abcabc".replace(/b/g, "X"));
  console.log("abcabc".replaceAll(/b/g, "X"));

  console.log("ab ac".replace(/a(.)/g, "<$1>"));
  console.log("ab".replace(/(a)(b)/, "$2$1"));
  console.log("ab".replace(/(a)(c)?/, "[$1][$2]"));
  console.log("a".replace(/(a)/, "$10"));
  console.log("a".replace(/(a)/, "$2"));

  console.log("abc".replace(/b/, "[$&]-<$`|$'>-$$"));
  console.log("xxx".replace(/z/, "Q"));

  const rg = /b/g;
  rg.lastIndex = 99;
  console.log("abcabc".replace(rg, "X"), rg.lastIndex);
  console.log("abcabc".replaceAll(rg, "Y"), rg.lastIndex);

  const ri = /abc/i;
  console.log("ABC".replace(ri, "x"), ri.lastIndex);

  console.log("a😀😀b".replace(/😀+/g, "E"));
  console.log("😀x".replace(/(?:)/gu, "|"));

  const sticky = /ab/y;
  sticky.lastIndex = 2;
  console.log("xxab".replace(sticky, "Q"), sticky.lastIndex);
  sticky.lastIndex = 1;
  console.log("xxab".replace(sticky, "Q"), sticky.lastIndex);

  console.log("ab ac".replace(/a(.)/g, (m: string, c: string, off: number, s: string) => `${m}:${c}:${off}:${s.length}`));
  console.log("ab".replace(/(a)(c)?/, (m: string, a: string, c: string | undefined, off: number) => `${a}/${c === undefined}/${off}`));
  console.log("a1b2".replaceAll(/\d/g, (m: string, off: number) => String(Number(m) + off)));
  let n = 0;
  const rfn = /b/g;
  rfn.lastIndex = 7;
  console.log("abcabc".replace(rfn, (m: string, off: number) => { n++; return `${m}${off}`; }), n, rfn.lastIndex);
  console.log("ab".replace(/b/, function(m: string): string { return m.toUpperCase(); }));
}
main();
