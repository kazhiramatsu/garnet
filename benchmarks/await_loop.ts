async function double(x: number): Promise<number> { return x * 2; }
async function main(): Promise<void> {
  let sum = 0;
  for (let i = 1; i <= 4; i++) {
    sum = sum + await double(i);
  }
  console.log(sum);   // 2+4+6+8 = 20
}

main();
