// Symbol-keyed STATIC class members: methods, fields, and accessors keyed by a
// well-known symbol (Symbol.toPrimitive) or a user symbol install on the class's
// static container and are read back via `C[sym]`. `this` inside a static
// symbol method/accessor is the class itself, and inheritance flows through the
// proto-linked container chain. Dynamic-STRING-keyed static members (`static [k]`)
// install the same way (a plain string property on the container).

const mySym = Symbol("my");
const accSym = Symbol("acc");
const dynKey = "computed";

class Box {
  static n = 10;

  // well-known: consulted by +Box / String(Box) for free (ts_to_primitive).
  static [Symbol.toPrimitive](hint: string): number | string {
    return hint === "number" ? Box.n * 4 : "Box";
  }

  // user-symbol method; `this` is the class.
  static [mySym](): number {
    return Box.n + 5;
  }

  // user-symbol field.
  static [Symbol.for("tag")] = 99;

  // user-symbol accessor with a backing store.
  static _v = 1;
  static get [accSym](): number {
    return Box._v;
  }
  static set [accSym](x: number) {
    Box._v = x;
  }

  // dynamic-string-keyed static field + method.
  static [dynKey] = 7;
  static ["m" + "k"](): number {
    return 123;
  }
}

class SubBox extends Box {} // inherits all static symbol members

function main(): void {
  // well-known static [Symbol.toPrimitive]
  console.log(+Box); // 40
  console.log(String(Box)); // Box
  console.log(`${Box}`); // Box

  // user-symbol method, this = class
  console.log((Box as any)[mySym]()); // 15

  // user-symbol (registered) field
  console.log((Box as any)[Symbol.for("tag")]); // 99

  // user-symbol accessor (get/set with backing store)
  console.log((Box as any)[accSym]); // 1
  (Box as any)[accSym] = 8;
  console.log((Box as any)[accSym]); // 8
  console.log(Box._v); // 8

  // dynamic-string static members
  console.log((Box as any)["computed"]); // 7
  console.log((Box as any)["mk"]()); // 123

  // inheritance via the proto-linked static container chain
  console.log((SubBox as any)[mySym]()); // 15
  console.log((SubBox as any)[Symbol.for("tag")]); // 99
  console.log(+SubBox); // 40
}

main();
