function kernel(N: number): number {
  const s = "ab-cd-ef-gh-ij-kl-mn-op-qr-st".repeat(1024);
  let sum = 0;
  let i = 0;
  while (i < N) {
    const r = s.replaceAll("-", "+");
    sum = sum + r.length + r.indexOf("+") + r.charCodeAt(0);
    i = i + 1;
  }
  return sum + s.length;
}

console.log(kernel(20000));
