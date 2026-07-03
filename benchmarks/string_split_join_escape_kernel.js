const BENCH_N = 1000000;

function kernel(N) {
  const csv = "alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa,lambda,mu";
  let sum = 0;
  let i = 0;
  let last = "";
  while (i < N) {
    const parts = csv.split(",");
    const joined = parts.join("|");
    last = joined;
    sum = sum + joined.length + joined.charCodeAt(0) + joined.charCodeAt(joined.length - 1);
    i = i + 1;
  }
  return sum + last.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
