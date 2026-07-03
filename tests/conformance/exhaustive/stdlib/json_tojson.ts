// JSON.stringify honors a value's `toJSON(key)` method (SerializeJSONProperty
// step 2): the value is replaced by toJSON()'s result before serialization,
// toJSON receives the property key, and an undefined result omits an object
// property (but yields null for an array element). Works for object-literal
// methods (FIELD key) and class methods (METHOD key) alike.
class Point {
  constructor(public x: number, public y: number) {}
  toJSON(): any {
    return { type: "point", x: this.x, y: this.y };
  }
}

function main(): void {
  // object-literal toJSON returning an object / primitive / string
  console.log(JSON.stringify({ toJSON() { return { custom: 1 }; } }));
  console.log(JSON.stringify({ toJSON() { return 42; } }));
  console.log(JSON.stringify({ toJSON() { return "hi"; } }));

  // nested + sibling untouched
  console.log(JSON.stringify({ a: { toJSON() { return "X"; } }, b: 2 }));

  // class instance, top-level and nested
  console.log(JSON.stringify(new Point(1, 2)));
  console.log(JSON.stringify({ p: new Point(3, 4) }));
  console.log(JSON.stringify([new Point(5, 6)]));

  // pretty-print routes through the same path
  console.log(JSON.stringify({ a: { toJSON() { return [1, 2]; } } }, null, 2));

  // undefined result: omit object property, null for array element
  console.log(JSON.stringify({ a: { toJSON() { return undefined; } }, b: 2 }));
  console.log(JSON.stringify([{ toJSON() { return undefined; } }]));

  // toJSON receives the property key (object key + array index + top-level "")
  console.log(JSON.stringify({ a: { toJSON(k: string) { return "k=" + k; } } }));
  console.log(JSON.stringify({ toJSON(k: string) { return "top[" + k + "]"; } }));
  console.log(JSON.stringify([{ toJSON(k: string) { return k; } }, { toJSON(k: string) { return k; } }]));

  // computed value from instance state
  class Money {
    constructor(public cents: number) {}
    toJSON(): any { return this.cents / 100; }
  }
  console.log(JSON.stringify({ price: new Money(1599) }));

  // no toJSON: ordinary serialization still works
  console.log(JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: 4 } }));
}
main();
