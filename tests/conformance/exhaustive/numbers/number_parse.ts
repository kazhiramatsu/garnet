function main(): void {
  console.log(parseInt("42"), parseFloat("3.14"));
  console.log(Number("123"), +"99");
  console.log(isNaN(NaN), isFinite(42));

  // ToNumber trims the FULL JS whitespace set on both ends (tab/LF/CR/VT/FF/
  // space), not just space — so a whitespace-only string is 0, and whitespace
  // around a number is tolerated (ECMA-262 7.1.4 / StrWhiteSpace).
  console.log(Number("\t"), Number("\n"), Number("\r"), Number("\v"), Number("\f")); // 0 0 0 0 0
  console.log(Number("\t\t"), Number("   "), Number(""), Number(" \t\n ")); // 0 0 0 0
  console.log(Number("\t12\t"), Number("\n3.5\r"), +"\t5", +"6\t");         // 12 3.5 5 6
  console.log(Number("\tx"), Number("1 2"), Number("\t1.2.3"));             // NaN NaN NaN
}

main();
