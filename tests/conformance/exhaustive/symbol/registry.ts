function main(): void {
  // Symbol.for: same key -> same symbol (===); different keys -> distinct.
  const a = Symbol.for("k");
  const b = Symbol.for("k");
  const c = Symbol.for("other");
  console.log(a === b, a === c);          // true false
  // Symbol.keyFor: registered key, or undefined for a plain symbol.
  console.log(Symbol.keyFor(a));          // k
  console.log(Symbol.keyFor(Symbol()) === undefined); // true
  // toString
  console.log(Symbol("desc").toString()); // Symbol(desc)
  console.log(Symbol().toString());       // Symbol()
  // a registry symbol works as a property key
  const o: any = {};
  o[a] = 99;
  console.log(o[Symbol.for("k")]);        // 99  (same symbol -> same key)
}
main();
