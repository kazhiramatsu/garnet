// An object-literal computed property with a symbol key (`{ [sym]: v }`) must be
// stored under the symbol key (like `o[sym] = v` and the `{ [sym]() {} }` method
// form), not stringified. User symbols and well-known symbols both work; string/
// numeric keys in the same literal are unaffected; the key is evaluated before
// the value (JS computed-key order).
function main(): void {
  // user symbol as a data property
  const s = Symbol("k");
  const o: any = { [s]: 5 };
  console.log(o[s]);                              // 5

  // multiple distinct user symbols don't collide; string/number keys coexist
  const s1 = Symbol("a"), s2 = Symbol("b");
  const mix: any = { [s1]: 1, [s2]: 2, x: 3, 4: "four" };
  console.log(mix[s1], mix[s2], mix.x, mix[4]);   // 1 2 3 four

  // well-known symbol used as a data-property value
  const wk: any = { [Symbol.iterator]: 7 };
  console.log(wk[Symbol.iterator]);               // 7

  // the computed key is evaluated before the value
  let order = "";
  const k = () => { order += "k"; return Symbol("s"); };
  const v = () => { order += "v"; return 1; };
  const ev: any = { [k()]: v() };
  console.log(order);                             // kv

  // a registered (global) symbol used as a literal key, read via the same symbol
  const g: any = { [Symbol.for("g")]: "G" };
  console.log(g[Symbol.for("g")]);               // G

  // distinct symbols with the same description are different keys
  const d1 = Symbol("d"), d2 = Symbol("d");
  const dd: any = { [d1]: "one", [d2]: "two" };
  console.log(dd[d1], dd[d2], d1 === d2);         // one two false
}
main();
