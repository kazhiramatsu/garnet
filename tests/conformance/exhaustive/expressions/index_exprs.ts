function main(): void {
  const a = [10, 20, 30, 40, 50];
  let i = 1;
  console.log(a[i + 1]);                  // 30  (i+1 numeric, not concat-ish)
  console.log(a[i * 2]);                  // 50
  console.log(a[a.length - 1]);           // 50
  const m: { [k: string]: number } = { "k1": 1, "k2": 2 };
  console.log(m["k" + (i + 1)]);          // m["k2"] = 2
  const obj: any = { 0: "a", 1: "b" };
  console.log(obj[i - 1], obj[i]);        // a b
  const grid = [[1, 2], [3, 4]];
  console.log(grid[i][i - 1]);            // grid[1][0] = 3
  let s = "hello";
  console.log(s[i + 1]);                  // l
  console.log(s.charCodeAt(i * 2));       // 'l' = 108
}
main();
