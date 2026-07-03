function first<T>(a: T[]): T { return a[0]; }
function pair<A, B>(a: A, b: B): string { return `${a},${b}`; }
function main(): void {
  console.log(first([10, 20, 30]), first(["a", "b"]));
  console.log(pair(1, "x"), pair(true, 42));
}

main();
