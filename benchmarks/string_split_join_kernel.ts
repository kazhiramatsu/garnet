function kernel(N: number): number {
  const csv = "alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa,lambda,mu";
  let sum = 0;
  let i = 0;
  while (i < N) {
    const parts = csv.split(",");
    const joined = parts.join("|");
    sum = sum + parts.length + joined.length + parts[3].length;
    i = i + 1;
  }
  return sum;
}

console.log(kernel(5000000));
