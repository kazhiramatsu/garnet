// console.log / console.dir display symbol-keyed own ENUMERABLE properties, which
// Node's util.inspect renders as `Symbol(desc): value` (no brackets, never quoted)
// AFTER the string/index keys. A symbol-keyed data property (o[sym]=v / {[sym]:v})
// is enumerable, so it shows; the property key (a uint32) can't carry the symbol's
// description, so the runtime keeps a sym_id->description side table to recover it.
// Object.keys / JSON.stringify must still EXCLUDE symbols (spec). Plain objects are
// used throughout (tsaot doesn't print the `ClassName {` tag that Node does).

const sx = Symbol("x");
const sNo = Symbol();
const sReg = Symbol.for("k");

function main(): void {
  // string + symbol (string first), value quoting
  console.log({ a: 1, [sx]: "X" });

  // symbol-only object
  console.log({ [Symbol("only")]: 1 });

  // no description, and a registered (Symbol.for) symbol
  console.log({ [sNo]: 1 });
  console.log({ [sReg]: 2 });

  // multiple symbols in insertion order, interleaved with strings
  console.log({ z: 0, [Symbol("a")]: 1, m: 2, [Symbol("b")]: 3 });

  // well-known symbol used as a data-property key
  const wk: any = {};
  wk[Symbol.iterator] = 9;
  console.log(wk);

  // nested object / array / object values
  console.log({ o: { [Symbol("s")]: 1 } });
  console.log({ [Symbol("arr")]: [1, 2], [Symbol("obj")]: { z: 1 } });
  console.log([{ [Symbol("e")]: 1 }]);

  // console.dir
  console.dir({ a: 1, [Symbol("d")]: "D" });

  // an object whose only symbol property is NON-enumerable -> "{}" (hidden)
  const ne: any = {};
  Object.defineProperty(ne, Symbol("hidden"), { value: 5, enumerable: false });
  console.log(ne);

  // regression: symbols never appear in Object.keys / JSON.stringify, and the
  // symbol value is still readable (display is not a fiction).
  const sq = Symbol("q");
  const mix: any = { a: 1 };
  mix[sq] = 2;
  console.log(Object.keys(mix));
  console.log(JSON.stringify(mix));
  console.log(mix[sq]);
}

main();
