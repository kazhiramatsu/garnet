class Config {
  static base: number = 10;
  static doubled: number = Config.base * 2;
  static label: string = "cfg";
}
function main(): void { console.log(Config.base, Config.doubled, Config.label); }
main();
