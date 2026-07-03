function main(): void {
  const a = [10, 20, 30];
  let s = 0;
  for (const x of a) s += x;
  console.log(s);
  for (const ch of "abc") console.log(ch);
  let wide = "";
  for (const ch of "A😀B") wide += ch + ":" + ch.length + "|";
  console.log(wide);
}

main();
