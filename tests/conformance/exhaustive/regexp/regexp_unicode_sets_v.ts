function main(): void {
  console.log(/😀/v.test("x😀y"));
  console.log(/^.$/v.test("😀"));
  console.log(/^.$/.test("😀"));

  const empty: any = "😀x".match(/(?:)/gv);
  console.log(empty.length, empty.join("|"));

  const r = new RegExp("😀", "v");
  console.log(r.test("😀"), r.source, r.flags);
}
main();
