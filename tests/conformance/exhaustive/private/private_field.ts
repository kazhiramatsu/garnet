class Counter {
  #count: number = 0;
  inc(): void { this.#count = this.#count + 1; }
  get(): number { return this.#count; }
}
function main(): void {
  const c = new Counter();
  c.inc();
  c.inc();
  console.log(c.get());
}
main();
