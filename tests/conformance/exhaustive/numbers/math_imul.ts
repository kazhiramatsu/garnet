function main(): void {
  console.log(Math.imul(2, 4), Math.imul(-1, 8), Math.imul(0xffffffff, 5));
  console.log(Math.imul(0x7fffffff, 2), Math.imul(0x80000000, 2));
  console.log(Math.imul("3" as any, true as any), Math.imul(NaN, 7), Math.imul(1 / 0, 7));

  const imul = Math.imul;
  console.log(imul(123456, 789), imul.length, typeof imul);
}

main();
