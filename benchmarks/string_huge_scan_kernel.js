const BENCH_N = 100000000;

function kernel(N) {
  const s = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".repeat(16384);
  const len = s.length;
  let idx = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    idx = idx + 97;
    if (idx >= len) idx = idx - len;
    sum = sum + s.charCodeAt(idx);
    i = i + 1;
  }
  return sum + len;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
