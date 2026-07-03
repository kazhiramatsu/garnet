function adjust(x: number): number {
  if (x < 0) return 0;
  return x + 1;
}

function loopNonInlineHelper(n: number): number {
  let s = 0;
  let i = 0;
  while (i < n) {
    s = s + adjust(i);
    i = i + 1;
  }
  return s;
}

function even(n: number): number {
  if (n <= 0) return 1;
  return odd(n - 1);
}

function odd(n: number): number {
  if (n <= 0) return 0;
  return even(n - 1);
}

function divisor(i: number): number {
  if (i < 0) return 1;
  return (i % 10) + 1;
}

function modLoop(n: number): number {
  let s = 0;
  let i = 0;
  while (i < n) {
    s = (s + i) % divisor(i);
    i = i + 1;
  }
  return s;
}

console.log(loopNonInlineHelper(100));
console.log(even(20));
console.log(odd(21));
console.log(modLoop(1000));
