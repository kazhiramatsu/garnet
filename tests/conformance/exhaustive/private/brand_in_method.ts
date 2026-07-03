class Vertex {
  #val: number = 0;
  constructor(v: number) { this.#val = v; }
  equals(other: object): boolean {
    if (#val in other) { return true; }
    return false;
  }
}
function main(): void {
  const a = new Vertex(1);
  const b = new Vertex(2);
  console.log(a.equals(b));
  console.log(a.equals({}));
}
main();
