// Array.push / Array.unshift accept multiple arguments and return the new length.
function main(): void {
  const a = [1];
  console.log(a.push(2, 3), a.join(","));   // 3 1,2,3
  console.log(a.push(9), a.join(","));       // 4 1,2,3,9

  const b = [3];
  console.log(b.unshift(1, 2), b.join(",")); // 3 1,2,3
  console.log(b.unshift(0), b.join(","));    // 4 0,1,2,3

  // the returned length is usable as a number.
  const c = [1, 2];
  const len = c.push(3);
  console.log(len * 2);                      // 6

  // push inside a loop with multiple args.
  const d: number[] = [];
  for (let i = 0; i < 3; i++) d.push(i, i * 10);
  console.log(d.join(","));                  // 0,0,1,10,2,20
}

main();
