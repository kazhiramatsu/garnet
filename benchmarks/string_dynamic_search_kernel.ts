function kernel(N: number): number {
  const s0 = "0123456789abcdefXYZ".repeat(24) + "needle" + "tailXYZ";
  const s1 = "klmnopqrstuvXYZ".repeat(28) + "needle" + "doneXYZ";
  const s2 = "ABCDEFGHXYZ".repeat(36) + "needle" + "stopXYZ";
  const s3 = "wxyz0123XYZ".repeat(34) + "needle" + "lastXYZ";
  let pick = 0;
  let from = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let s = s0;
    if (pick === 1) s = s1;
    else if (pick === 2) s = s2;
    else if (pick === 3) s = s3;
    sum = sum + s.indexOf("needle", from);
    sum = sum + s.lastIndexOf("XYZ", s.length);
    from = from + 17;
    if (from >= 128) from = from - 128;
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum;
}

console.log(kernel(3000000));
