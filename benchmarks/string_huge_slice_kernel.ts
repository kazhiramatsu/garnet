function kernel(N: number): number {
  const s = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".repeat(16384);
  const width = 48;
  const span = s.length - width;
  let start = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    start = start + 257;
    if (start >= span) start = start - span;
    const a = s.slice(start, start + 16);
    const b = s.substring(start + 40, start + 24);
    sum = sum + a.charCodeAt(0) + b.charCodeAt(15) + a.length + b.length;
    i = i + 1;
  }
  return sum + s.length;
}

console.log(kernel(35000000));
