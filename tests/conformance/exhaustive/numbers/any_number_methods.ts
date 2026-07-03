function main(): void {
  // A number held in an `any`-typed binding resolves its builtin methods
  // dynamically through Number.prototype (mirroring the string case).
  const n: any = 3.14159;
  console.log(n.toFixed(2));               // 3.14
  console.log(n.toFixed(0));               // 3
  console.log(n.toPrecision(4));           // 3.142

  const i: any = 255;
  console.log(i.toString());               // 255
  console.log(i.toString(16));             // ff
  console.log(i.toString(2));              // 11111111
  console.log(i.toString(8));              // 377

  const v: any = 41;
  console.log(v.valueOf() + 1);            // 42

  const neg: any = -2.5;
  console.log(neg.toFixed(1));             // -2.5

  const whole: any = 10;
  console.log(whole.toFixed());            // 10

  // Combined with optional chaining.
  console.log(n?.toFixed(3));              // 3.142
}
main();
