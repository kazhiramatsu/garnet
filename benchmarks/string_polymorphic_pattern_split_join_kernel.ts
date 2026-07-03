function kernel(N: number): number {
  const s = "alpha,beta;gamma:delta|epsilon,zeta;eta:theta|iota,kappa;lambda:mu";
  const p0 = ",";
  const p1 = ";";
  const p2 = ":";
  const p3 = "|";
  const j0 = "|";
  const j1 = "/";
  const j2 = "+";
  const j3 = "=";
  let pick = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let sep = p0;
    let joiner = j0;
    if (pick === 1) {
      sep = p1;
      joiner = j1;
    } else if (pick === 2) {
      sep = p2;
      joiner = j2;
    } else if (pick === 3) {
      sep = p3;
      joiner = j3;
    }
    const parts = s.split(sep);
    const joined = parts.join(joiner);
    sum = sum + parts.length + joined.length + parts[1].length;
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum + s.length + p0.length + j3.length;
}

console.log(kernel(1500000));
