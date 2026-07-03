function main(): void {
  const r1 = new RegExp("ab+");
  console.log(r1.test("zzabbb"), r1.source, r1.flags, r1.lastIndex);

  const r2 = RegExp("ab+", "ig");
  console.log(r2.test("AB"), r2.source, r2.flags, r2.lastIndex);

  const pat = "a(b)";
  const fl = "dg";
  const r3 = new RegExp(pat, fl);
  const m: any = r3.exec("xab");
  console.log(m[0], m[1], m.indices[1][0], m.indices[1][1], r3.lastIndex);

  const named = new RegExp("(?<left>a)(?<right>b)?", "d");
  const nm: any = named.exec("xa");
  console.log(nm.groups.left, nm.groups.right, nm.indices.groups.left[0], nm.indices.groups.left[1], nm.indices.groups.right);

  const slash = new RegExp("a/b", "g");
  console.log(String(slash), slash.source, "a/b a/b".match(slash)!.join("|"));

  const empty = RegExp();
  console.log(String(empty), empty.test(""));

  const emoji = new RegExp("😀+", "u");
  console.log(emoji.test("😀😀"), emoji.source, emoji.flags);
}
main();
