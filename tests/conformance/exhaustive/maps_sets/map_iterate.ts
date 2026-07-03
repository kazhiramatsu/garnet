function main(): void {
  const m = new Map<string, number>();
  m.set("x", 10); m.set("y", 20);
  const keys: string[] = [];
  for (const k of m.keys()) keys.push(k);
  console.log(keys.join(","));
  let total = 0;
  for (const v of m.values()) total += v;
  console.log(total);
}

main();
