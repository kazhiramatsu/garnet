// Number-to-string, template literals, join, string equality on built strings.
function main(): void {
  let total = 0; const parts: string[] = [];
  for (let r = 0; r < 160000; r++) {
    parts.length = 0;
    for (let i = 0; i < 20; i++) parts.push(`${i}:${r & 7}`);
    const s = parts.join(","); if (s === "0:0,1:0,2:0") total++;
    total += s.length + ("" + r).length + (r + "x").length;
  }
  console.log(total);
}
main();
