function main(): void {
  let log: string[] = [];
  const f = (n: number): number => { log.push("f" + n); return n; };
  const r = f(1) + f(2) * f(3) - f(4);
  console.log(r, log.join(","));            // 3 f1,f2,f3,f4
  log = [];
  const g = (s: string): string => { log.push(s); return s; };
  console.log(g("a") + g("b") + g("c"), log.join(",")); // abc a,b,c
  let i = 0;
  const arr = [10, 20, 30];
  console.log(arr[i++] + arr[i++], i);      // 30 2
  let calls = 0;
  const obj = { get v() { calls++; return calls; } };
  console.log(obj.v + obj.v + obj.v);       // 1+2+3 = 6
}
main();
