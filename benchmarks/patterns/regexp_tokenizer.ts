// A sticky-regexp tokenizer (the shape of a hand-written lexer over `lastIndex`): whitespace,
// identifiers, numbers, strings and punctuators over a JS-like source, each token kind a sticky
// pattern tried at the current position (docs/regexp_vm_design.md, the R2 kernels).
const src = `
function fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
const names = ["alpha", "beta", "gamma\\"q\\""]; let total = 0.5;
for (let i = 0; i < names.length; i++) { total += names[i].length * 1.25; }
class Point { constructor(x, y) { this.x = x; this.y = y; } norm() { return Math.sqrt(this.x ** 2 + this.y ** 2); } }
export default { fib, names, total, Point, flag: total >= 10 && !(total % 2) };
`;
const ws = /\s+/y;
const ident = /[A-Za-z_$][\w$]*/y;
const num = /\d+(?:\.\d+)?/y;
const str = /"(?:[^"\\]|\\.)*"/y;
const punct = /[-+*/=<>!&|^%(){}[\];,.?:]+/y;
function lex(input: string): number[] {
  const counts = [0, 0, 0, 0, 0];
  let pos = 0;
  const n = input.length;
  while (pos < n) {
    ws.lastIndex = pos;
    if (ws.test(input)) { counts[0]++; pos = ws.lastIndex; continue; }
    ident.lastIndex = pos;
    if (ident.test(input)) { counts[1]++; pos = ident.lastIndex; continue; }
    num.lastIndex = pos;
    if (num.test(input)) { counts[2]++; pos = num.lastIndex; continue; }
    str.lastIndex = pos;
    if (str.test(input)) { counts[3]++; pos = str.lastIndex; continue; }
    punct.lastIndex = pos;
    if (punct.test(input)) { counts[4]++; pos = punct.lastIndex; continue; }
    pos++;
  }
  return counts;
}
function main(): void {
  let sum = 0;
  for (let round = 0; round < 15000; round++) {
    const c = lex(src);
    sum = (sum + c[0] * 1 + c[1] * 7 + c[2] * 13 + c[3] * 31 + c[4] * 97) | 0;
  }
  console.log(sum, lex(src).join(","));
}
main();
