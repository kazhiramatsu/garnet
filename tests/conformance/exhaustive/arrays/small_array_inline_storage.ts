function main(): void {
  const a: any = [1, 2, 3, 4];
  a.push(5);
  console.log(a.length, a[4]);

  a.splice(1, 3);
  console.log(a.length, a.join(","));

  a.unshift(0);
  a.push(6);
  console.log(a.join(","));

  a.push(7);
  console.log(a.join(","));

  let sum = 0;
  let i = 0;
  while (i < 2000) {
    const b: any = [i, i + 1, i + 2];
    sum = sum + b[2];
    i = i + 1;
  }
  console.log(sum);
}

main();
