const BENCH_N = 20000;

function kernel(N) {
  const s = "ab-cd-ef-gh-ij-kl-mn-op-qr-st".repeat(1024);
  let sum = 0;
  let i = 0;
  while (i < N) {
    const r = s.replaceAll("-", "+");
    sum = sum + r.length + r.indexOf("+") + r.charCodeAt(0);
    i = i + 1;
  }
  return sum + s.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
