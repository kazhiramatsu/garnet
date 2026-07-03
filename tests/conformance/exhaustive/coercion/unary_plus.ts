// Unary + is ToNumber: identity on numbers, coercion on strings/null/etc.
function main(): void {
  console.log(+"42", +"3.14", +"", String(+"abc")); // 42 3.14 0 NaN
  console.log(+true, +false, +null);                 // 1 0 0
  console.log(+"  42  ", +"0x10");                    // 42 16
  const s: string = "5";
  console.log(+s + 3);                               // 8
  const x: any = "100";
  console.log(+x);                                   // 100
  console.log(String(+(undefined as any)));          // NaN
}

main();
