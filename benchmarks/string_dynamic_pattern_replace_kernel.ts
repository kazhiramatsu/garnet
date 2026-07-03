function kernel(N: number): number {
  const s = "ab-cd-ef-gh-ij-kl-mn-op-qr-st".repeat(4);
  let pat = "-";
  let rep = "+";
  let needle = "+";
  if (N < 0) {
    pat = "--";
    rep = "*";
    needle = "*";
  }
  let sum = 0;
  let i = 0;
  while (i < N) {
    const r = s.replaceAll(pat, rep);
    sum = sum + r.length + r.indexOf(needle) + r.charCodeAt(0);
    i = i + 1;
  }
  return sum + pat.length + rep.length;
}

console.log(kernel(1000000));
