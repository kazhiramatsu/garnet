function main(): void {
  let n = 48;
  n += 2;
  n -= 10;
  n *= 3;
  n /= 4;
  n %= 8;
  n **= 3;
  n <<= 1;
  n >>= 2;
  n >>>= 1;
  n |= 8;
  n &= 13;
  n ^= 3;
  console.log(n);

  let andValue: number | null = 4;
  let orValue = 0;
  let nullish: number | undefined;
  andValue &&= 5;
  orValue ||= 6;
  nullish ??= 7;
  console.log(andValue, orValue, nullish);
}

main();
