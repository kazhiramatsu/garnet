let count = 0;
const step = 5;
class Counter {
  inc(): void { count = count + step; }
  read(): number { return count; }
}
function main(): void {
  const c = new Counter();
  c.inc();
  c.inc();
  console.log(c.read());
  console.log(count);
}
main();
