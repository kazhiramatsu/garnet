function half(x: number): number {
  if (x < 0) {
    return x / -2;
  }
  return x / 2;
}

function divide(x: number, y: number): number {
  return x / y;
}

function sum3(a: number, b: number, c: number): number {
  return a + b + c;
}

function valueOnly(x: number): number {
  return x * 0.5;
}

console.log(half(3.5));
console.log(half(-3.5));
console.log(sum3(0.25, 1.5, 2.25));
console.log(Object.is(divide(-0, 2), -0));
console.log(Object.is(divide(0, 0), NaN));
console.log(divide(1, 0));
console.log(divide(-1, 0));

const callAsValue = valueOnly;
console.log(callAsValue(5.5));
