function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertIsNumber(x: unknown): asserts x is number { if (typeof x !== "number") throw new Error("not number"); }

function process(x: unknown): number {
  assertIsNumber(x);
  return x * 2;            // x narrowed to number
}
function main(): void {
  let caught = "";
  try { assert(1 === 2, "boom"); } catch (e) { caught = (e as Error).message; }
  console.log(caught);                              // boom
  console.log(process(21));                         // 42
  const v: unknown = 5;
  assert(typeof v === "number", "x");
  console.log(v + 1);                               // 6
}
main();
