function* values(): Generator<number> { yield 3; yield 5; }
function total(input: Iterable<number>): number {
  let sum = 0;
  for (const value of input) sum += value;
  return sum;
}
console.log(total(values()));
const iterator: any = values();
console.log(iterator[Symbol.iterator]() === iterator);
const next = iterator.next;
console.log(JSON.stringify(next.call(iterator)));
console.log(JSON.stringify(iterator.return(9)));
console.log(JSON.stringify(iterator.next()));
async function* asyncValues(): AsyncGenerator<number> { yield 7; yield 11; }
const asyncIterator: any = asyncValues();
console.log(asyncIterator[Symbol.asyncIterator]() === asyncIterator);
asyncIterator.next().then((result: IteratorResult<number>) => console.log("async", result.value));
