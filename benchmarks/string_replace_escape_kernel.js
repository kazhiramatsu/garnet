const BENCH_N = 1000000;

function kernel(N) {
  const s = "ab-cd-ef-gh-ij-kl-mn-op-qr-st".repeat(4);
  let sum = 0;
  let i = 0;
  let last = "";
  while (i < N) {
    const r = s.replaceAll("-", "+");
    last = r;
    sum = sum + r.length + r.indexOf("+") + r.charCodeAt(0);
    i = i + 1;
  }
  return sum + last.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
