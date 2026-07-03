function f(): string {
  try {
    try {
      return "inner";
    } finally {
      console.log("inner-finally");
    }
  } finally {
    console.log("outer-finally");
  }
}
function main(): void { console.log(f()); }

main();
