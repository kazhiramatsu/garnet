// Template substitutions of number types (docs/string_build_fast_paths_design.md): under the strict
// profile their ToString is left to the join, which formats an integer's digits on the stack. Every
// kind of number, adjacent number substitutions (never added), a lone substitution, and the string
// building paths around them (a local's appends, a property's appends, short and long pieces).
enum Level { Low = 1, High = 20 }
const nums: number[] = [0, -0, 1, -1, 7, 42, 99999, 100000, 123456789, -2147483648, 2147483647, 4294967296,
  9007199254740991, -9007199254740991, 1e21, 1e-7, 0.1, 1.5, -2.25, 3.14159, NaN, Infinity, -Infinity, 2 ** 53 + 2];
const out: string[] = [];
for (const n of nums) {
  out.push(`${n}`);
  out.push(`[${n}]`);
  out.push(`${n}${n}`);
  out.push(`${n}:${n | 0}:${n >>> 0}`);
  out.push(`a${n}b${n * 2}c${n + 0.5}d`);
}
const a = 1, b = 2;
out.push(`${a}${b}`, `${a}${b}${a}`, `x${a}${b}`, `${a + b}${a - b}`);
const lv: Level = Level.High;
out.push(`level ${lv} ${Level.Low}`);
let k: number | undefined = 5;
out.push(`k=${k}`);
k = undefined;
out.push(`k=${k}`);
const big = `${"x".repeat(30)}${12345}${"y".repeat(30)}`;
out.push(big, String(big.length));
// appends: a local and a property, pieces short and long, numbers through the template
let s = "";
const ctx = { code: "" };
for (let i = 0; i < 300; i++) {
  s += `${i},`;
  s += "é";
  ctx.code += i % 3 === 0 ? "(" : `${i}`;
  ctx.code += "abcdefghijklmnopqrstuvwxyz0123456789";
}
out.push(String(s.length), s.slice(0, 40), s.slice(-40), String(ctx.code.length), ctx.code.slice(100, 160));
console.log(out.join("|"));
