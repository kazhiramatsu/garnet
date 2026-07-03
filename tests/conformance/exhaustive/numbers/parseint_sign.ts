// parseInt: optional leading whitespace then an optional sign, then digits must
// follow immediately (no space / second sign between sign and digits).
function main(): void {
  console.log(parseInt(" -42"), parseInt("+99"), String(parseInt("- 5"))); // -42 99 NaN
  console.log(String(parseInt("--5")), String(parseInt("+-5")));           // NaN NaN
  console.log(parseInt("42"), parseInt("  100  "), parseInt("3.9"));       // 42 100 3
  console.log(parseInt("ff", 16), parseInt("101", 2), parseInt("z", 36));  // 255 5 35
  console.log(parseInt("-0x10"), parseInt("+0xFF"));                       // -16 255
  console.log(String(parseInt("")), String(parseInt("abc")));              // NaN NaN
}

main();
