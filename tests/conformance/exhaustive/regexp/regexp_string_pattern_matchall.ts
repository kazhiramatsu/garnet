function main(): void {
  const a: any = Array.from("ababa".matchAll("a"));
  console.log(a.length, a[0][0], a[0].index, a[1].index, a[2].input);

  const empty: any = Array.from("ab".matchAll());
  console.log(empty.length, empty[0].index, empty[1].index, empty[2].index);

  const emoji: any = Array.from("😀😀".matchAll("😀"));
  console.log(emoji.length, emoji[0].index, emoji[1].index);
}
main();
