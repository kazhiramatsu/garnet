// `Object.prototype.toString.call(x)` applies the SPEC Object.prototype.toString
// to an arbitrary `this`, producing the internal [[Class]]-style tag — distinct
// from `x.toString()` (which dispatches to the most-derived toString). So an array
// yields "[object Array]" (not its join), and primitives get their wrapper tags.
// A string-valued [Symbol.toStringTag] overrides the builtin tag. `.apply` behaves
// the same (toString takes no params, so the args array is irrelevant).

class Plain {
  x = 1;
}

class Tagged {
  get [Symbol.toStringTag](): string {
    return "Widget";
  }
}

function main(): void {
  // builtin tags by type
  console.log(Object.prototype.toString.call({ a: 1 })); // [object Object]
  console.log(Object.prototype.toString.call([1, 2, 3])); // [object Array]
  console.log(Object.prototype.toString.call(5)); // [object Number]
  console.log(Object.prototype.toString.call("s")); // [object String]
  console.log(Object.prototype.toString.call(true)); // [object Boolean]
  console.log(Object.prototype.toString.call(null)); // [object Null]
  console.log(Object.prototype.toString.call(undefined)); // [object Undefined]
  console.log(Object.prototype.toString.call(() => 1)); // [object Function]

  // class instance without an own toString -> [object Object]
  console.log(Object.prototype.toString.call(new Plain())); // [object Object]

  // [Symbol.toStringTag] override
  console.log(Object.prototype.toString.call(new Tagged())); // [object Widget]

  // .apply form
  console.log(Object.prototype.toString.apply([1])); // [object Array]
  console.log(Object.prototype.toString.apply(42)); // [object Number]

  // distinct from x.toString(): the array's own toString joins
  console.log([1, 2, 3].toString()); // 1,2,3
}

main();
