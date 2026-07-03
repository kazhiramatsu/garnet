const BENCH_N = 5000;

function kernel(N) {
  const block = "0123456789abcdef".repeat(65536) + "XYZ";
  const hay = block + "needle";
  let from = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    sum = sum + hay.indexOf("needle", from);
    sum = sum + hay.lastIndexOf("XYZ", hay.length);
    from = from + 97;
    if (from >= 8192) from = from - 8192;
    i = i + 1;
  }
  return sum + hay.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
