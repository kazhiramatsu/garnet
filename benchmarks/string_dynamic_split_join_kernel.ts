function kernel(N: number): number {
  const s0 = "alpha,beta,gamma,delta,epsilon,zeta,eta,theta";
  const s1 = "iota,kappa,lambda,mu,nu,xi,omicron,pi";
  const s2 = "rho,sigma,tau,upsilon,phi,chi,psi,omega";
  const s3 = "red,green,blue,cyan,magenta,yellow,black,white";
  let pick = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let csv = s0;
    if (pick === 1) csv = s1;
    else if (pick === 2) csv = s2;
    else if (pick === 3) csv = s3;
    const parts = csv.split(",");
    const joined = parts.join("|");
    sum = sum + parts.length + joined.length + parts[3].length;
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum;
}

console.log(kernel(1500000));
