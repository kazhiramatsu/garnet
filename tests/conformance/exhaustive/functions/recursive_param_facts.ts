// What the callers prove of a parameter holds for every call, the function's own among them: the integer entry of a
// recursive function took the constant of the one outside call for the parameter (`gcd`'s `b` for 462, silently).
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }
console.log(1, gcd(1071, 462));
function modulo(n: number, m: number): number { return n === 0 ? 0 : modulo(n - 1, m + 1) + (10 % m); }
console.log(1, modulo(3, 2));
function shift(x: number, k: number): number { return k > 3 ? x : shift(x << k, k + 1); }
console.log(1, shift(1, 1));
function divide(a: number, b: number): number { return b > 5 ? a : divide((a / b) | 0, b + 1); }
console.log(1, divide(1000, 2));
function flip(n: number, m: number): number { return n === 0 ? m : flip(n - 1, -m - 1); }
console.log(1, flip(3, 5));
function grow(n: number, a: number): number { return n === 0 ? a : grow(n - 1, a * 65536); }
console.log(1, grow(4, 3));
function inner(i: number, s: number): number { let t = s; for (let j = 0; j < 3; j++) t += j % i; return i > 4 ? t : inner(i + 1, t); }
console.log(1, inner(1, 0));
function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }
console.log(1, fact(25));
// no recursion: `g` is called with an integer and with a fraction, so `y + 1` proves nothing in `g`'s integer entry
function h(a: number): number { return 100 % a; }
function g(y: number): number { return h(y + 1); }
console.log(g(1), g(1.5), h(7));
function times(y: number): number { return h(y * 3); }
function both(z: number): number { return times(z) + times(z + 1); }
console.log(both(1), both(2), h(9));
function a(n: number): number { return n === 0 ? 0 : b(n - 1, 7 % (n + 1)); }
function b(n: number, m: number): number { return m + a(n) % 3; }
console.log(1, a(4));
// A return fact is the integer entry's: `keep(-1)` proves nothing of `keep(-2.5)`, which takes the double entry.
function pad(p0: number, p1: number): number {
  let s = p1 * 5 - (p1 >> p1);
  for (let i = 0; i < 1; i++) s = ~Math.abs(-7 | 0);
  return s;
}
function keep(p0: number): number {
  const a = -7;
  let b = a;
  if (((1e21 << a) as number) < b) b = pad((b as number) >= 1e-7 ? p0 : a, a & p0);
  return p0;
}
function caller(p0: number): number {
  let b = ~Math.sign(p0);
  if ((~p0 as number) < b) b = keep(-1);
  return b;
}
console.log(1, keep(-2.5), caller(3), keep(1), keep(0.5) + 1, -keep(0));
// Modulo 2^32 is a ring of exact integers: a fraction beside an operand, or a product a double rounds, is outside it.
function wrapBeside(p0: number, p1: number, p2: number): number {
  let s = (p1 * 2) % (p2 + p1);
  for (let i = 0; i < 3; i++) s = (Math.max(1e-7, s) - (p0 + p2)) ^ (s / (p2 ^ p0));
  return s;
}
console.log(1, wrapBeside(8, 3, 4294967296));
function rounded(a: number, b: number): number { const x = a + 1; const y = b + 1; return (x * y) | 0; }
console.log(1, rounded(3037000499, 3037000499));
