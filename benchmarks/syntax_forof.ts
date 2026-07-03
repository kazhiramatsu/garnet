function sumArr(): number {
  const a = [10, 20, 30, 40];
  let s = 0;
  for (const x of a) { s = s + x; }   // 100
  return s;
}
function buildAndSum(n: number): number {
  const a: number[] = [];
  let i = 0;
  while (i < n) { a.push(i * i); i = i + 1; }   // push squares
  let s = 0;
  for (const x of a) { s = s + x; }
  return s;
}
function indexed(): number {
  const a = [5, 6, 7];
  a[1] = 60;
  return a[0] + a[1] + a[2] + a.length;  // 5+60+7+3 = 75
}
function main(): void {
  console.log(sumArr());        // 100
  console.log(buildAndSum(5));  // 0+1+4+9+16 = 30
  console.log(indexed());       // 75
}

main();
