function main(): void {
  const fns: Array<() => number> = [];
  for (let i = 0; i < 3; i++) { fns.push(() => i); }
  console.log(fns[0](), fns[1](), fns[2]());
  let total = 0;
  const add = (n: number) => { total += n; return total; };
  console.log(add(5), add(10), add(3));
}

main();
