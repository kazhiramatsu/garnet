function kernel(N: number): number {
  const s0 = "ab-cd-ef-gh-ij-kl-mn-op-qr-st".repeat(3);
  const s1 = "uv-wx-yz-ab-cd-ef-gh-ij-kl-mn".repeat(3);
  const s2 = "op-qr-st-uv-wx-yz-ab-cd-ef-gh".repeat(3);
  const s3 = "ij-kl-mn-op-qr-st-uv-wx-yz-ab".repeat(3);
  let pick = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let s = s0;
    if (pick === 1) s = s1;
    else if (pick === 2) s = s2;
    else if (pick === 3) s = s3;
    const r = s.replaceAll("-", "+");
    sum = sum + r.length + r.indexOf("+") + r.charCodeAt(0);
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum;
}

console.log(kernel(1500000));
