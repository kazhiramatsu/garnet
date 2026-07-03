function f(): number {
  let s = 10;
  s += 5;          // compound -> 15
  s -= 2;          // 13
  s *= 2;          // 26
  s %= 7;          // 5
  let t = s++;     // postfix: t=5, s=6
  let u = ++s;     // prefix: s=7, u=7
  const neg = -s;  // -7
  const a = (s > 0) && (s < 100);  // true (1)
  const b = (s > 100) || 42;       // 42
  const tern = s > 5 ? 100 : 200;  // 100
  let acc = t + u + neg;           // 5 + 7 + (-7) = 5
  acc = acc + (a ? 1 : 0) + b + tern;  // 5 + 1 + 42 + 100 = 148
  return acc;
}
function main(): void { console.log(f()); }

main();
