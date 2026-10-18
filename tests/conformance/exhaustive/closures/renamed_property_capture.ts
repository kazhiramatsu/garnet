function renamed(): number {
  function produce(path: number): { path: number } { return { path }; }
  function consume(): number {
    const { path: result } = produce(12);
    return result;
  }
  return consume();
}

let counter = 4;
function addCounter(n: number): number { return n + counter; }
class Reader {
  read(n: number): number { return addCounter(n); }
  spread(n: number): number {
    const args: [number] = [n];
    return addCounter(...args);
  }
}

let initial = 8;
function initialValue(): number { return initial; }
class StaticReader {
  static value = initialValue();
}

function recursiveValue(): number {
  const f = function visit(n: number): number {
    const next = () => visit;
    return n === 0 ? 1 : next()(n - 1) + 1;
  };
  return f(3);
}

console.log(renamed(), recursiveValue());
const reader = new Reader();
console.log(reader.read(2), StaticReader.value);
counter = 10;
console.log(reader.read(2));
console.log(reader.spread(3));

const immutable = function self(): boolean {
  try {
    // @ts-ignore: strict JavaScript rejects writes to a named function binding.
    self = () => true;
    return false;
  } catch (error) {
    return (error as Error).name === "TypeError";
  }
};
console.log(immutable());
