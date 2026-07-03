class M {
  static value: number = 0;
  static {
    let tmp = 0;
    for (let i = 1; i <= 4; i = i + 1) { tmp = tmp + i; }
    M.value = tmp;
  }
}
function main(): void { console.log(M.value); }
main();
