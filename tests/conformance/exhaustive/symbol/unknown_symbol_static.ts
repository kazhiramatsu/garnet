// A well-known symbol the runtime does not define, read as a value: `Symbol.observable` is undefined (as in
// V8 without a polyfill), so the usual feature test falls back to a string key; the known statics still work.
declare global { interface SymbolConstructor { readonly observable: symbol; } }
const observable: string | symbol = (() => (typeof Symbol === "function" && Symbol.observable) || "@@observable")();
class Source {
  [observable](): string { return "source"; }
  [Symbol.iterator](): Iterator<number> { let i = 0; return { next: () => (i < 2 ? { value: i++, done: false } : { value: undefined, done: true }) }; }
}
function main(): void {
  const out: string[] = [];
  out.push(String(Symbol.observable === undefined), typeof observable, String(observable));
  const s = new Source();
  out.push((s as unknown as Record<string, () => string>)["@@observable"](), String([...s].join("|")), String(typeof Symbol.iterator), String(Symbol.for("k") === Symbol.for("k")));
  console.log(out.join("\n"));
}
main();
