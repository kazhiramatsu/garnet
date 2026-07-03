function kernel(N: number): number {
  let sum = 0;
  let i = 0;
  while (i < N) {
    const a: any = [i, i + 1, i + 2];
    sum = sum + a[1];
    i = i + 1;
  }
  return sum;
}

console.log(kernel(3000000));
