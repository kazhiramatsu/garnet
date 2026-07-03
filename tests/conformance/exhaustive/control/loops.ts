function main(): void {
  let s = 0;
  for (let i = 0; i < 10; i++) s += i;
  console.log(s);
  let j = 0, p = 1;
  while (j < 5) { p *= 2; j++; }
  console.log(p);
  let k = 0; do { k++; } while (k < 3);
  console.log(k);
}

main();
