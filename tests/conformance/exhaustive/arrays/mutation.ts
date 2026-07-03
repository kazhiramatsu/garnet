function main(): void {
  const a = [1, 2, 3];
  a.push(4, 5); console.log(a.join(","));
  console.log(a.pop(), a.join(","));
  console.log(a.shift(), a.join(","));
  a.unshift(0); console.log(a.join(","));
  a.reverse(); console.log(a.join(","));
}

main();
