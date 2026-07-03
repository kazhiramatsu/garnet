function main(): void {
  const s = new Set<number>();
  s.add(1); s.add(2); s.add(2); s.add(3);
  console.log(s.size, s.has(2), s.has(9));
  s.delete(2);
  console.log(s.size, s.has(2));
  let prod = 1;
  s.forEach((v) => { prod *= v; });
  console.log(prod);
}

main();
