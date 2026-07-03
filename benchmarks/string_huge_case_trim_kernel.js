const BENCH_N = 10000;

function kernel(N) {
  const s = " \t " + "Hello String Kernel 123 xyz ABC ".repeat(4096) + " \n ";
  let sum = 0;
  let i = 0;
  while (i < N) {
    const a = s.trim();
    const b = a.toUpperCase();
    const c = b.toLowerCase();
    sum = sum + c.length + c.charCodeAt(0) + c.charCodeAt(c.length - 1);
    i = i + 1;
  }
  return sum + s.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
