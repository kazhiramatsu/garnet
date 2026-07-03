// A bare `Array.prototype` (and the other builtin prototypes) used as a first-class
// value. In JS, Array.prototype is itself an Array exotic object: typeof is "object",
// Array.isArray(Array.prototype) is true, its length is 0, spreading it is empty, and
// it has stable identity. The other builtin prototypes (String/Map/Set/Number) are
// plain objects (isArray false). V8 is the oracle.
//
// (console.log(Array.prototype) renders specially in Node — `Object(0) []` — so we
// avoid printing the object directly and assert the observable scalar facts instead.)

function main(): void {
  const p = Array.prototype;

  // Array.prototype is an array: typeof "object", isArray true, length 0, empty spread.
  console.log(typeof p);                       // object
  console.log(Array.isArray(p));               // true
  console.log(Array.isArray(Array.prototype)); // true
  console.log(Array.prototype.length);         // 0
  console.log([...Array.prototype].length);    // 0

  // stable identity
  console.log(Array.prototype === Array.prototype); // true
  console.log(p === Array.prototype);               // true

  // methods are still reachable off the bare prototype value (the §90 method values)
  console.log(typeof Array.prototype.map);     // function
  console.log(typeof p.slice);                 // function

  // other builtin prototypes are plain objects (isArray false)
  console.log(typeof String.prototype, Array.isArray(String.prototype)); // object false
  console.log(typeof Map.prototype, Array.isArray(Map.prototype));       // object false
  console.log(typeof Set.prototype, Array.isArray(Set.prototype));       // object false
  console.log(typeof Number.prototype, Array.isArray(Number.prototype)); // object false

  // a real array still works normally (regression: the proto-kind change is invisible)
  const a = [1, 2, 3];
  console.log(Array.isArray(a), a.length, a.map((x) => x * 2).join(","));
  console.log(Array.isArray([]), Array.isArray("x"), Array.isArray({}));
}

main();
