function compose(f: (x: number) => number, g: (x: number) => number): (x: number) => number {
  return (x) => f(g(x));
}
function main(): void {
  const inc = (x: number) => x + 1;
  const dbl = (x: number) => x * 2;
  console.log(compose(inc, dbl)(5), compose(dbl, inc)(5));
}

main();
