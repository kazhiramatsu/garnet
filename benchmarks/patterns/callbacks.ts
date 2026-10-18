// Array methods with arrow callbacks capturing locals (tsc uses forEach/some/map/filter heavily).
function main(): void {
  const arr: number[] = []; for (let i = 0; i < 1000; i++) arr.push(i);
  let total = 0;
  for (let r = 0; r < 24000; r++) {
    const base = r & 7; let acc = 0;
    arr.forEach(x => { acc += x + base; });
    const m = arr.map(x => x * 2 + base);
    const f = arr.filter(x => (x & 3) === base % 4);
    const s = arr.some(x => x > 990 + base);
    total += acc + m[999] + f.length + (s ? 1 : 0);
  }
  console.log(total);
}
main();
