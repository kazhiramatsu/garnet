// The first operand's ToPrimitive result stays live while the second
// operand converts: that conversion may run a collection (`<`, `+`).
function churn(n: number): number {
  const junk: any[] = [];
  for (let i = 0; i < n; i++) junk.push({ i, s: "c" + i + "-junk-operand" });
  return junk.length;
}
function main() {
  let fresh = 0;
  const a: any = { toString() { fresh++; return "z" + fresh + "-left-operand"; } };
  const b: any = { toString() { churn(150000); return "k" + fresh + "-right-operand"; } };
  const out: string[] = [];
  for (let r = 0; r < 3; r++) out.push(String(a < b) + String(a >= b) + String(b > a));
  const c: any = { valueOf() { return "v" + out.length + "-first-operand"; } };
  const d: any = { valueOf() { churn(150000); return "-second"; } };
  for (let r = 0; r < 3; r++) out.push(c + d);
  console.log(out.join(" "));
}
main();
