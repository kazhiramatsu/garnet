class Calc {
  #double(n: number): number { return n * 2; }
  compute(x: number): number { return this.#double(x) + 1; }
}
function main(): void { console.log(new Calc().compute(5)); }
main();
