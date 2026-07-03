const base = 100;
function scale(x: number): number { return x * base; }
function main(): void {
  console.log(scale(2));
  console.log(scale(3));
}
main();
