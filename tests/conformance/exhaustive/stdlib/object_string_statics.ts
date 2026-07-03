function main(): void {
  // Object.getOwnPropertyNames — for plain objects, the own (enumerable) keys.
  console.log(Object.getOwnPropertyNames({ x: 1, y: 2, z: 3 }).join(","));  // x,y,z
  console.log(Object.getOwnPropertyNames({}).length);                       // 0
  const o: any = {};
  o.first = 1;
  o.second = 2;
  console.log(Object.getOwnPropertyNames(o).join(","));                     // first,second

  // String.fromCodePoint — full code points (UTF-8 encoded), unlike fromCharCode.
  console.log(String.fromCodePoint(72, 105));        // Hi
  console.log(String.fromCodePoint(233));            // é
  console.log(String.fromCodePoint(0x1F600));        // 😀
  console.log(String.fromCodePoint(0x41, 0x2764, 0x1F602)); // A❤😂
}
main();
