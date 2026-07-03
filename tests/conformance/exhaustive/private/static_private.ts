class Registry {
  static #count: number = 0;
  static add(): void { Registry.#count = Registry.#count + 1; }
  static total(): number { return Registry.#count; }
}
function main(): void { Registry.add(); Registry.add(); console.log(Registry.total()); }
main();
