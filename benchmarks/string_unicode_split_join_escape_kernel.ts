function kernel(N: number): number {
  const s0 = ("alpha😀βeta😀gamma😀delta😀").repeat(16) + "omega";
  const s1 = ("iota😀κappa😀lambda😀mu😀").repeat(16) + "omega";
  const s2 = ("rho😀sigma😀tau😀upsilon😀").repeat(16) + "omega";
  const s3 = ("phi😀chi😀psi😀omega😀").repeat(16) + "omega";
  const sep = "😀";
  const joiner = "éZ";
  let pick = 0;
  let sum = 0;
  let i = 0;
  let last = "";
  while (i < N) {
    let s = s0;
    if (pick === 1) s = s1;
    else if (pick === 2) s = s2;
    else if (pick === 3) s = s3;
    const parts = s.split(sep);
    const joined = parts.join(joiner);
    last = joined;
    sum = sum + parts.length + joined.length + parts[3].length + joined.charCodeAt((pick * 17) & 127);
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum + last.length + last.indexOf(joiner);
}

console.log(kernel(200000));
