class Box { v: number; constructor(v: number) { this.v = v; } get(): number { return this.v; } }
let g: Box | null = null;
function make(n: number): Box {
  const b = new Box(n);   // ESCAPES via return -> no SROA
  return b;
}
function main(): void {
  const b = make(42);
  console.log(b.get());
  // also a non-escaping one in the same function -> SROA eligible
  const local = new Box(7);
  console.log(local.get());
}

main();
