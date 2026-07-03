// hasOwnProperty / Object.hasOwn / the `in` operator over exotic own properties:
// array index (canonical only) + length, string index + length, function length/
// name (and call/apply/bind inherited). V8 is the oracle.

function main(): void {
  // --- array hasOwnProperty: in-bounds index and length are own ---
  const a = [10, 20, 30];
  console.log(a.hasOwnProperty("0"), a.hasOwnProperty("2"), a.hasOwnProperty("3")); // true true false
  console.log(a.hasOwnProperty("length"));                                          // true
  // non-canonical index strings are NOT array indices
  console.log(a.hasOwnProperty("00"), a.hasOwnProperty("01"), a.hasOwnProperty("-0")); // false false false
  console.log(a.hasOwnProperty("1e0"), a.hasOwnProperty(" 1"), a.hasOwnProperty("+1")); // false false false
  // 2^32-1 is the max length, NOT a valid index; 2^32-2 is in-range form but out of bounds
  console.log(a.hasOwnProperty("4294967295"), a.hasOwnProperty("4294967294"));       // false false
  // a numeric key coerces to its string index
  console.log(a.hasOwnProperty(0 as unknown as string), a.hasOwnProperty(5 as unknown as string)); // true false
  // explicitly-assigned own props still work (prop map)
  const a2: number[] & { foo?: number } = [1];
  a2.foo = 9;
  console.log(a2.hasOwnProperty("foo"), a2.hasOwnProperty("bar")); // true false
  // Object.hasOwn agrees
  console.log(Object.hasOwn(a, "0"), Object.hasOwn(a, "length"), Object.hasOwn(a, "5")); // true true false

  // --- string hasOwnProperty (via the spec Object.prototype.hasOwnProperty) ---
  const H = Object.prototype.hasOwnProperty;
  console.log(H.call("abc", "0"), H.call("abc", "2"), H.call("abc", "3")); // true true false
  console.log(H.call("abc", "length"));                                    // true

  // --- function hasOwnProperty: length/name own, call inherited ---
  function f(x: number, y: number): number { return x + y; }
  console.log(f.hasOwnProperty("length"), f.hasOwnProperty("name"), f.hasOwnProperty("call")); // true true false
  const anon = function () {};
  const arrow = (x: number) => x;
  console.log(anon.hasOwnProperty("name"), arrow.hasOwnProperty("length"), arrow.hasOwnProperty("name")); // true true true

  // --- the `in` operator: arrays (canonical index/length) and functions ---
  console.log("0" in a, "00" in a, "01" in a, "length" in a, "5" in a); // true false false true false
  console.log("length" in f, "name" in f, "call" in f, "foo" in f);     // true true true false
  console.log("toString" in f, "hasOwnProperty" in f);                  // true true (inherited)

  // --- regression: plain objects unchanged ---
  const o = { a: 1 };
  console.log(o.hasOwnProperty("a"), o.hasOwnProperty("toString"), o.hasOwnProperty("z")); // true false false
  const oa: { a: number; b?: number } = { a: 1 };
  console.log("a" in oa, "b" in oa, "toString" in oa); // true false true
  console.log(JSON.stringify(Object.keys(a)));         // ["0","1","2"] (length not enumerable)
  let order = "";
  for (const k in [5, 6]) order += k + ",";
  console.log(order);                                  // 0,1,
}

main();
