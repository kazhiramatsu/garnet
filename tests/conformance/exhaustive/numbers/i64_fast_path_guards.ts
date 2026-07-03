function id(n: number): number {
  return n;
}

function isSmall(n: number): boolean {
  return n < 3;
}

function yes(): boolean {
  return true;
}

console.log(id(1));
console.log(id(1.5));
console.log(Object.is(id(-0), -0));
console.log(isSmall(1));
console.log(isSmall(5));
console.log(yes());
