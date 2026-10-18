function reduce<T>(array: T[], initial?: T): T | undefined {
  return arguments.length <= 1 ? array[0] : initial;
}
console.log(reduce([4, 5]), reduce([4, 5], 9), reduce([4, 5], undefined));
function outer(offset: number): (value?: number) => number {
  return function (value = 3): number { return offset + arguments.length + value; };
}
const count = outer(10);
console.log(count(), count(5));
class Counter {
  offset = 20;
  count(...values: number[]): number { return this.offset + arguments.length + values.length; }
}
const counter = new Counter();
console.log(counter.count(), counter.count(1, 2, 3));
const indirect: any = count;
console.log(indirect(1, 2, 3));
