class Picker {
  v: number = 0;
  pick(flag: boolean): boolean {
    if (flag) { return true; }
    return false;
  }
  classify(n: number): string {
    if (n < 0) { return "neg"; }
    if (n === 0) { return "zero"; }
    return "pos";
  }
}
function main(): void {
  const p = new Picker();
  console.log(p.pick(true));
  console.log(p.pick(false));
  console.log(p.classify(-3));
  console.log(p.classify(0));
  console.log(p.classify(7));
}
main();
