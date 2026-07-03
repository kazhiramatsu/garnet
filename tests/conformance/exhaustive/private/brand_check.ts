class Box {
  #secret: number = 42;
  static isBox(obj: object): boolean { return #secret in obj; }
}
function main(): void {
  const b = new Box();
  console.log(Box.isBox(b));
  console.log(Box.isBox({}));
}
main();
