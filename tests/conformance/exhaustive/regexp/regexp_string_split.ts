function main(): void {
  console.log("a,b,c".split(/,/).join("|"));
  console.log("a,b,c".split(/,/, 2).join("|"));
  console.log("a,b,c".split(/,/, 0).length);
  console.log("abc".split(/z/).join("|"));

  console.log("a1b2c".split(/(\d)/).join("|"));
  console.log("a-b--c".split(/(-)/).join("|"));
  console.log("aXb".split(/x/i).join("|"));

  console.log("ab".split(/(?:)/).join("|"));
  console.log("".split(/(?:)/).length);
  console.log("😀x😀".split(/😀/u).join("|"));

  const rg = /,/g;
  rg.lastIndex = 2;
  console.log("a,b,c".split(rg).join("|"), rg.lastIndex);

  const sticky = /,/y;
  sticky.lastIndex = 99;
  console.log("a,b,c".split(sticky).join("|"), sticky.lastIndex);
}
main();
