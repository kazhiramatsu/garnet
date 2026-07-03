const BENCH_N = 5000000;

function kernel(N) {
  const s = " \t Hello String Kernel 123 xyz ABC \n ";
  let sum = 0;
  let i = 0;
  let last = "";
  while (i < N) {
    const a = s.trim();
    const b = a.toUpperCase();
    const c = b.toLowerCase();
    last = c;
    sum = sum + c.length + c.charCodeAt(0) + c.charCodeAt(c.length - 1);
    i = i + 1;
  }
  return sum + last.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
