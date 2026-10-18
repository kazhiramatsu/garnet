// Strict equality on any-typed operands: identical values compare equal except
// NaN, and distinct heap values with equal contents compare by content only
// for strings.
function main(): void {
  const nan: any = NaN;
  const o1: any = { a: 1 };
  const o2: any = { a: 1 };
  const s1: any = "ab";
  const s2: any = "a" + "b";
  const arr: any = [1];
  const f: any = function () { return 1; };
  const zero: any = 0;
  const negZero: any = -0;
  console.log(nan === nan, nan !== nan, nan == nan, Object.is(nan, nan));
  console.log(o1 === o1, o1 === o2, o1 == o2, arr === arr, f === f);
  console.log(s1 === s2, s1 !== s2, s1 === "ab", s2 == "ab");
  console.log(zero === negZero, Object.is(zero, negZero), 1 / zero === 1 / negZero);
  const u: any = undefined; const n: any = null;
  console.log(u === u, n === n, u === n, u == n);
  const big: any = 12345678901234567890;
  console.log(big === big, big === 12345678901234567890, big + 0 === big);
  const inf: any = Infinity;
  console.log(inf === inf, -inf === inf, inf - inf === inf - inf);
}
main();
