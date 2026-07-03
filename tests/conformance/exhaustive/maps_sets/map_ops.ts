function main(): void {
  const m = new Map<string, number>();
  m.set("a", 1); m.set("b", 2); m.set("c", 3);
  console.log(m.get("a"), m.get("b"), m.has("c"), m.has("z"), m.size);
  m.delete("a");
  console.log(m.has("a"), m.size);
  let sum = 0;
  m.forEach((v) => { sum += v; });
  console.log(sum);
}

main();
