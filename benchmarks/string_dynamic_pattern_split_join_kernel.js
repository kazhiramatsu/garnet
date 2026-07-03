const BENCH_N = 3000000;

function kernel(N) {
  const csv = "alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa,lambda,mu";
  let sep = ",";
  let joiner = "|";
  if (N < 0) {
    sep = ";";
    joiner = "/";
  }
  let sum = 0;
  let i = 0;
  while (i < N) {
    const parts = csv.split(sep);
    const joined = parts.join(joiner);
    sum = sum + parts.length + joined.length + parts[3].length;
    i = i + 1;
  }
  return sum + sep.length + joiner.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
