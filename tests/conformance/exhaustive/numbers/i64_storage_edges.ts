function plusOne(x: number): number {
  return x + 1;
}

console.log(plusOne(1.5)); // 2.5

const g = plusOne;
console.log(g(1.5)); // 2.5

function negZeroParam(x: number): void {
  console.log(Object.is(-x, -0));
}

negZeroParam(0); // true

const h = negZeroParam;
h(0); // true

function product(x: number, y: number): number {
  return x * y;
}

console.log(1 / product(0, -1)); // -Infinity
console.log(1 / product(-1, 0)); // -Infinity
console.log(1 / product(0, 1)); // Infinity
