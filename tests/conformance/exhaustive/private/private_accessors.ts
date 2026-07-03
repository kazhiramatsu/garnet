class Temp {
  #celsius: number = 0;
  set c(v: number) { this.#celsius = v; }
  get f(): number { return this.#celsius * 9 / 5 + 32; }
}
function main(): void {
  const t = new Temp();
  t.c = 100;
  console.log(t.f);
}
main();
