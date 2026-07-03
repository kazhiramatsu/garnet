const BENCH_N = 1000000;

function kernel(N) {
  const s = "ab-cd-ef-gh-ij-kl-mn-op-qr-st".repeat(4);
  let pat = "-";
  let rep = "+";
  let needle = "+";
  if (N < 0) {
    pat = "--";
    rep = "*";
    needle = "*";
  }
  let sum = 0;
  let i = 0;
  while (i < N) {
    const r = s.replaceAll(pat, rep);
    sum = sum + r.length + r.indexOf(needle) + r.charCodeAt(0);
    i = i + 1;
  }
  return sum + pat.length + rep.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
