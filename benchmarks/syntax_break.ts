function firstOver(n: number): number {
  let i = 0;
  while (i < 1000) {
    if (i * i > n) { break; }   // break in while
    i = i + 1;
  }
  return i;
}
function sumOdds(n: number): number {
  let s = 0;
  let i = 0;
  while (i < n) {
    i = i + 1;
    if (i % 2 === 0) { continue; }  // continue in while (safe: increment before)
    s = s + i;
  }
  return s;
}
function findInArr(): number {
  const a = [3, 1, 4, 1, 5, 9, 2, 6];
  let found = -1;
  for (const x of a) {
    if (x === 9) { found = x; break; }  // break in for-of
  }
  return found;
}
function main(): void {
  console.log(firstOver(50));   // i*i>50 -> i=8 (64>50)
  console.log(sumOdds(10));     // 1+3+5+7+9 = 25
  console.log(findInArr());     // 9
}

main();
