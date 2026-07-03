function main(): void {
  const a = Symbol("a");
  const b = Symbol.for("b");
  const o: any = { x: 1 };
  o[a] = 10;
  Object.defineProperty(o, b, { value: 20 });
  o[Symbol.iterator] = 30;

  const syms = Object.getOwnPropertySymbols(o);
  console.log(syms.length);
  console.log(syms[0] === a, syms[1] === b, syms[2] === Symbol.iterator);
  console.log(o[syms[0]], o[syms[1]], o[syms[2]]);
  console.log(Object.keys(o).join(","), JSON.stringify(o));
  const getSyms = Object.getOwnPropertySymbols;
  console.log(getSyms(o)[0] === a, getSyms.length, typeof getSyms);

  const db: any = Object.getOwnPropertyDescriptor(o, b);
  console.log(db.enumerable, db.writable, db.configurable, db.value);

  const hidden = Symbol("hidden");
  const lit: any = { [hidden]: 7, y: 2 };
  console.log(Object.getOwnPropertySymbols(lit)[0] === hidden, lit[Object.getOwnPropertySymbols(lit)[0]]);
}

main();
