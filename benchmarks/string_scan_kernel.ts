function kernel(N: number): number {
  const s = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".repeat(32);
  const len = s.length;
  let idx = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    idx = idx + 17;
    if (idx >= len) idx = idx - len;
    sum = sum + s.charCodeAt(idx);
    i = i + 1;
  }
  return sum;
}

console.log(kernel(100000000));
