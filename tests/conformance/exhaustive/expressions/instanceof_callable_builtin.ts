// `instanceof` whose right-hand side is a callable builtin behind a feature test (`typeof BigInt !==
// "undefined" && v instanceof BigInt`, yaml's createNode): the test decides, and a constructor value held
// in a variable or chosen by a conditional works through the runtime check; a non-callable right-hand
// side, and a function without a prototype, throw the TypeError both engines raise.
class Box { constructor(public v: number) {} }
function main(): void {
  const out: string[] = [];
  const v: unknown = 5;
  out.push(String(typeof BigInt !== "undefined" && v instanceof BigInt), String(typeof Box !== "undefined" && new Box(1) instanceof Box));
  const C: new (v: number) => Box = Box;
  const pick = (f: boolean): (new (v: number) => Box) | ((...a: unknown[]) => void) => (f ? C : Math.max);
  out.push(String(new Box(2) instanceof C), String(new Box(3) instanceof pick(true)));
  // a function without a prototype (Math.max) as the right-hand side: the TypeError both engines raise
  try { void (({}) instanceof pick(false)); out.push("no throw"); } catch (e) { out.push("max: " + (e as Error).constructor.name); }
  let thrown = "";
  try { void ((v as object) instanceof (undefined as unknown as new () => object)); } catch (e) { thrown = (e as Error).constructor.name; }
  out.push(thrown);
  console.log(out.join("\n"));
}
main();
