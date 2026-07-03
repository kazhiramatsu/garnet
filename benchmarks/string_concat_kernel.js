const BENCH_N = 50000000;

function kernel(N) {
  const chunk = "abcdef0123456789";
  let s = "";
  let sum = 0;
  let i = 0;
  while (i < N) {
    s = s + chunk;
    if (s.length >= 1024) {
      sum = sum + s.length + s.charCodeAt(3);
      s = "";
    }
    i = i + 1;
  }
  return sum + s.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
