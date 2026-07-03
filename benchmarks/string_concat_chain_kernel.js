const BENCH_N = 5000000;

function kernel(N) {
  const prefix = "row:";
  const marker = "😀";
  const tail = ":x";
  let sum = 0;
  let last = "";
  let i = 0;
  while (i < N) {
    const s = prefix + i + ":" + marker + tail;
    last = s;
    sum = sum + s.length + s.charCodeAt(0) + s.charCodeAt(s.length - 1) + s.indexOf(marker);
    i = i + 1;
  }
  return sum + last.length + last.indexOf(marker);
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
