function main(): void {
  const m1: any = "abc".match("b");
  console.log(m1[0], m1.index, m1.input, m1.length);

  const m2: any = "xab".match("a(b)");
  console.log(m2[0], m2[1], m2.index);

  console.log("abc".match("z"));
  console.log("abc".search("b"), "abc".search("z"));

  const slashPat = "a/b";
  const slashMatch: any = "xa/b".match(slashPat);
  console.log("xa/b".search(slashPat), slashMatch[0], slashMatch.index);

  const empty: any = "abc".match("");
  console.log(empty[0], empty.index, "abc".search(""));

  const emojiPat = "😀+";
  const emoji: any = "x😀😀y".match(emojiPat);
  console.log(emoji[0], emoji.index, "x😀😀y".search(emojiPat));

  const noArgMatch: any = "abc".match();
  console.log(noArgMatch[0], noArgMatch.index, "abc".search());
}
main();
