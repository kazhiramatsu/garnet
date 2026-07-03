function kernel(N: number): number {
  const s = "ab-cd-ef-gh-ij-kl-mn-op-qr-st".repeat(4);
  let sum = 0;
  let i = 0;
  while (i < N) {
    const r = s.replaceAll("-", "+");
    sum = sum + r.length + r.indexOf("+") + r.charCodeAt(0);
    i = i + 1;
  }
  return sum;
}

console.log(kernel(1000000));
