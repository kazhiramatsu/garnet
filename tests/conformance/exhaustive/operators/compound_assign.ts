function main(): void {
  // arithmetic compound (existing) + exponent.
  let a = 2; a **= 10; console.log(a);      // 1024
  let b = 17; b %= 5; console.log(b);       // 2

  // bitwise compound.
  let c = 12; c &= 10; console.log(c);      // 8
  let d = 5; d |= 2; console.log(d);        // 7
  let e = 6; e ^= 3; console.log(e);        // 5
  let f = 1; f <<= 4; console.log(f);       // 16
  let g = 256; g >>= 2; console.log(g);     // 64

  // logical-assignment with short-circuit.
  let h: any = null; h ??= 5; console.log(h);    // 5
  let i: any = 0; i ??= 9; console.log(i);       // 0 (not nullish)
  let j: any = 0; j ||= 10; console.log(j);      // 10
  let k: any = 1; k &&= 20; console.log(k);      // 20
}
main();
