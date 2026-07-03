function main(): void {
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  const pair = String.fromCharCode(0xd83d, 0xde00);
  const bad = high + "x" + low + pair;

  console.log("abc".isWellFormed(), pair.isWellFormed(), bad.isWellFormed());
  const fixed = bad.toWellFormed();
  console.log(fixed.length, fixed.charCodeAt(0), fixed.charAt(1), fixed.charCodeAt(2), fixed.codePointAt(3));

  const bad2 = String.fromCharCode(0xd800, 0xd800, 0xdc00, 0xdc00);
  const fixed2 = bad2.toWellFormed();
  console.log(bad2.isWellFormed(), fixed2.length, fixed2.charCodeAt(0), fixed2.codePointAt(1), fixed2.charCodeAt(3));

  const any: any = bad;
  console.log(any.isWellFormed(), any.toWellFormed().charCodeAt(0));
}
main();
