function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) { yield i; }
}
function main(): void {
  // nested for-of generators: each needs its own g/r locals
  let sum = 0;
  for (const i of range(3)) {
    for (const j of range(3)) {
      sum = sum + i * 10 + j;
    }
  }
  // i,j pairs: (0,0)(0,1)(0,2)(1,0)... = sum of (i*10+j) for i,j in 0..2
  // i=0: 0+1+2=3; i=1: 10+11+12=33; i=2: 20+21+22=63 => 99
  console.log(sum);   // 99
  // triple nesting
  let count = 0;
  for (const a of range(2)) {
    for (const b of range(2)) {
      for (const c of range(2)) {
        count = count + 1;
      }
    }
  }
  console.log(count);  // 2*2*2 = 8
}

main();
