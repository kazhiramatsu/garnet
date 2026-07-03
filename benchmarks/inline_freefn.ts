function sq(x: number): number { return x * x; }
function main(): void {
  let s = 0; let i = 0;
  while (i < 1000) { s = s + sq(i); i = i + 1; }
  console.log(s);   // sum of squares 0..999 = 332833500
}

main();
