const BENCH_N = 5000000;

function kernel(N) {
  const hay = ("a😀éZ|").repeat(64) + "needle😀" + "tailéZ";
  let needle = "😀é";
  let tail = "éZ";
  if (N < 0) {
    needle = "missing";
    tail = "QQQ";
  }
  let from = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    sum = sum + hay.indexOf(needle, from);
    sum = sum + hay.lastIndexOf(tail, hay.length);
    from = from + 17;
    if (from >= 256) from = from - 256;
    i = i + 1;
  }
  return sum + needle.length + tail.length + hay.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
