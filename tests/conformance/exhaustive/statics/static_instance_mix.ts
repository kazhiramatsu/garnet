class Box {
  static total: number = 0;
  v: number;
  constructor(v: number) { this.v = v; Box.total = Box.total + v; }
  get(): number { return this.v; }
  static getTotal(): number { return Box.total; }
}
function main(): void {
  const a = new Box(3);
  const b = new Box(7);
  console.log(a.get(), b.get(), Box.getTotal());
}
main();
