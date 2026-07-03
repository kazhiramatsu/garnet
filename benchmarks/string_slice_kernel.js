const BENCH_N = 35000000;

function kernel(N) {
  const s = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".repeat(64);
  const width = 48;
  const span = s.length - width;
  let start = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    start = start + 23;
    if (start >= span) start = start - span;
    const a = s.slice(start, start + 16);
    const b = s.substring(start + 40, start + 24);
    sum = sum + a.charCodeAt(0) + b.charCodeAt(15) + a.length + b.length;
    i = i + 1;
  }
  return sum;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
