function main(): void {
  const s = new Set<any>([2, 1, 2, "x"]);
  console.log(Array.from(s.keys()).join(","));
  console.log(Array.from(s.entries()).map((p: any) => String(p[0]) + ":" + String(p[1])).join("|"));

  let out = "";
  for (const p of s.entries()) out += String(p[0]) + "=" + String(p[1]) + ";";
  console.log(out);

  const keys = Set.prototype.keys;
  const entries = Set.prototype.entries;
  console.log(Array.from(keys.call(s)).join(","));
  console.log(Array.from(entries.call(s)).map((p: any) => String(p[0]) + "/" + String(p[1])).join(","));
}

main();
