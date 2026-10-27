// String(symbol) is the descriptive string; concatenation and a template literal throw a TypeError.
function main(): void {
  const s = Symbol("x");
  const it = Symbol.iterator;
  console.log(String(s), String(it), s.toString(), it.toString(), String(Symbol()), s.description, typeof it);
  const k: PropertyKey = it;
  console.log(String(k), typeof k === "symbol" ? "sym" : "str");
  const o: Record<string, number> = {};
  o["a" + String(it)] = 1;
  console.log(Object.keys(o)[0]);
  try { console.log("x" + (s as unknown as string)); } catch (e) { console.log("concat:", (e as Error).constructor.name); }
  try { console.log(`${s as unknown as string}!`); } catch (e) { console.log("template:", (e as Error).constructor.name); }
  try { console.log((s as unknown as string) + 1); } catch (e) { console.log("concat2:", (e as Error).constructor.name); }
}
main();
