class Counter {
  static count: number = 0;
  static inc(): void { Counter.count = Counter.count + 1; }
}
function main(): void {
  Counter.inc();
  Counter.inc();
  Counter.inc();
  console.log(Counter.count);
}
main();
