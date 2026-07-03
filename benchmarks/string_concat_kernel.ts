function kernel(N: number): number {
  const chunk = "abcdef0123456789";
  let s = "";
  let sum = 0;
  let i = 0;
  while (i < N) {
    s = s + chunk;
    if (s.length >= 1024) {
      sum = sum + s.length + s.charCodeAt(3);
      s = "";
    }
    i = i + 1;
  }
  return sum + s.length;
}

console.log(kernel(50000000));
