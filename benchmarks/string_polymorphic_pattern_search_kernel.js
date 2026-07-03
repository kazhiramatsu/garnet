const BENCH_N = 5000000;

function kernel(N) {
  const pad = "0123456789abcdef".repeat(32);
  const hay = pad + "needleA" + pad + "needleB" + pad + "needleC" + pad + "needleD" + pad;
  const n0 = "needleA";
  const n1 = "needleB";
  const n2 = "needleC";
  const n3 = "needleD";
  let pick = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let needle = n0;
    if (pick === 1) needle = n1;
    else if (pick === 2) needle = n2;
    else if (pick === 3) needle = n3;
    sum = sum + hay.indexOf(needle);
    sum = sum + hay.lastIndexOf(needle);
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum + hay.length + n0.length + n3.length;
}

function main() { console.log(kernel(BENCH_N)); }
if (typeof module !== "undefined") module.exports = { kernel, BENCH_N };
if (typeof require === "undefined" || require.main === module) main();
