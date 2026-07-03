function kernel(N: number): number {
  const s = "ab-cd_ef:gh|ij-kl_mn:op|qr-st_uv:wx|yz".repeat(4);
  const p0 = "-";
  const p1 = "_";
  const p2 = ":";
  const p3 = "|";
  const r0 = "+";
  const r1 = "=";
  const r2 = ";";
  const r3 = ",";
  let pick = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let pat = p0;
    let rep = r0;
    if (pick === 1) {
      pat = p1;
      rep = r1;
    } else if (pick === 2) {
      pat = p2;
      rep = r2;
    } else if (pick === 3) {
      pat = p3;
      rep = r3;
    }
    const out = s.replaceAll(pat, rep);
    sum = sum + out.length + out.indexOf(rep) + out.charCodeAt(0);
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum + s.length + p0.length + r3.length;
}

console.log(kernel(1000000));
