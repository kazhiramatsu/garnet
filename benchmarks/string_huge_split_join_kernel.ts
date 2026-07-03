function kernel(N: number): number {
  const csv = "alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa,lambda,mu,".repeat(2048) + "omega";
  let sum = 0;
  let i = 0;
  while (i < N) {
    const parts = csv.split(",");
    const joined = parts.join("|");
    sum = sum + parts.length + joined.length + parts[3].length;
    i = i + 1;
  }
  return sum + csv.length;
}

console.log(kernel(20000));
