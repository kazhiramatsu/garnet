function kernel(N: number): number {
  const s0 = ("😀éA|").repeat(48) + "tail";
  const s1 = ("B😀é|").repeat(48) + "tail";
  const s2 = ("éC😀|").repeat(48) + "tail";
  const s3 = ("Dé|😀").repeat(48) + "tail";
  const pat = "😀";
  const rep = "éZ";
  let pick = 0;
  let sum = 0;
  let i = 0;
  let last = "";
  while (i < N) {
    let s = s0;
    if (pick === 1) s = s1;
    else if (pick === 2) s = s2;
    else if (pick === 3) s = s3;
    const r = s.replaceAll(pat, rep);
    last = r;
    sum = sum + r.length + r.indexOf(rep) + r.lastIndexOf(rep) + r.charCodeAt((pick * 11) & 127);
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum + last.length + last.indexOf(rep);
}

console.log(kernel(200000));
