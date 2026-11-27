// A number parameter every call passes an integer, reassigned in the body with a value that is no
// integer (a fraction, a product past the int64 range, a NaN): the function's integer entry kept the
// parameter an integer local and truncated it (`p0 = 1.5` read as 1; the statements fuzzer, seed 26).
function f2(p0: number): number {
  if (65536 * p0 === 4294967296) {
    p0 = p0 * (p0 | 0);
  } else {
    p0 = 1.5;
  }
  return 16 >>> ((p0 + p0) | 0);
}
function g(p0: number): number {
  if (p0 > 100) { p0 = p0 * 2; } else { p0 = 1.5; }
  return (p0 + p0) | 0;
}
function big(p0: number, p1: number): number {
  if (p1 > 0) p0 = p0 * 4294967296 * 4294967296;
  return p0 > 1e18 ? 1 : 0;
}
function nan(p0: number): number {
  if (p0 === 3) p0 = p0 / 0 - p0 / 0;
  return p0 === p0 ? p0 : -1;
}
function loop(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) { n = n - 0.25; acc += n; }
  return acc;
}
console.log(f2(-1), f2(255), f2(65536), g(1), g(200), big(3, 1), big(3, 0), nan(3), nan(4), loop(4));
