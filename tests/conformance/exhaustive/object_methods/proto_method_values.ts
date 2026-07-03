// `Object.prototype.{toString,hasOwnProperty,valueOf}` are usable as first-class
// function values: `typeof` is "function", they can be stored in a variable, and
// `.call` / `.apply` / `.bind` supply the receiver as `this`. The `toString` value
// produces the spec [[Class]] tag ("[object Array]" etc.), distinct from a value's
// own toString. The classic `Object.prototype.hasOwnProperty.call(o, k)` idiom works.

const hop = Object.prototype.hasOwnProperty;
const ts = Object.prototype.toString;
const vo = Object.prototype.valueOf;

function main(): void {
  const o: any = { a: 1, b: undefined };
  const arr: any = [10, 20];

  // typeof -> "function"
  console.log(typeof Object.prototype.toString, typeof hop, typeof vo); // function function function

  // hasOwnProperty.call / .apply (the safe own-property idiom)
  console.log(Object.prototype.hasOwnProperty.call(o, "a")); // true
  console.log(Object.prototype.hasOwnProperty.call(o, "b")); // true (own, value undefined)
  console.log(Object.prototype.hasOwnProperty.call(o, "z")); // false
  console.log(hop.call(o, "a"), hop.call(o, "z")); // true false
  console.log(hop.apply(o, ["a"])); // true
  const bound = hop.bind(o);
  console.log(bound("a"), bound("z")); // true false

  // toString value -> spec tag (matches Object.prototype.toString.call)
  console.log(ts.call(o)); // [object Object]
  console.log(ts.call(arr)); // [object Array]
  console.log(ts.call(5)); // [object Number]
  console.log(ts.call("s")); // [object String]
  console.log(ts.call(true)); // [object Boolean]
  console.log(ts.call(null)); // [object Null]
  console.log(ts.call(undefined)); // [object Undefined]
  console.log(ts.call(() => 1)); // [object Function]

  // valueOf value -> identity (returns the receiver)
  console.log(vo.call(o) === o); // true
  console.log(Object.prototype.valueOf.call(arr) === arr); // true

  // hasOwnProperty.call on a class instance's declared field
  class C {
    x = 1;
  }
  const c = new C();
  console.log(Object.prototype.hasOwnProperty.call(c, "x")); // true
  console.log(Object.prototype.hasOwnProperty.call(c, "y")); // false

  // passing the value through a higher-order use
  const checks = ["a", "z", "b"].map((k) => hop.call(o, k));
  console.log(checks.join(",")); // true,false,true

  // regression: direct method calls unchanged
  console.log(o.hasOwnProperty("a"), o.toString(), o.valueOf() === o); // true [object Object] true
}

main();
