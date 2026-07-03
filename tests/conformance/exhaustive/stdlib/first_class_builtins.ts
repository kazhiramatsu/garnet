// Builtin functions/methods referenced as first-class VALUES (not just called):
// passed as callbacks, stored in variables, and `typeof`. Namespace statics
// (Math.sqrt, console.log, Object.keys, JSON.stringify, ...) and bare globals
// (parseInt, String, Number, Boolean) box a generated adapter; prototype methods
// (arr.push, "s".toUpperCase, ...) box the (unbound) prototype method via a method
// key, and bind/call/apply work on them.
function main(): void {
  // namespace static as a map/callback
  console.log([1, 4, 9, 16].map(Math.sqrt).join(","));    // 1,2,3,4
  console.log([-1, -2, 3].map(Math.abs).join(","));        // 1,2,3
  console.log([1.2, 2.7, 3.5].map(Math.round).join(","));  // 1,3,4

  // bare global conversion/parse functions as callbacks
  console.log([1, 2, 3].map(String).join("|"));            // 1|2|3
  console.log(["1", "2", "3"].map(Number).reduce((a, b) => a + b, 0)); // 6
  console.log([0, 1, "", 2].map(Boolean).join(","));       // false,true,false,true
  console.log(["1.5", "2.7"].map(parseFloat).map(Math.floor).join(",")); // 1,2
  console.log([0, 1, 2, 0, 3].filter(Boolean).join(","));  // 1,2,3

  // stored in a variable, then called
  const k = Object.keys;
  console.log(k({ a: 1, b: 2 }).join(","));                // a,b
  const j = JSON.stringify;
  console.log(j({ x: 1, y: 2 }));                          // {"x":1,"y":2}
  const p = parseInt;
  console.log(p("FF", 16), p("101", 2));                   // 255 5
  const f = console.log;
  f(42, "hi");                                             // 42 hi

  // typeof of builtin values -> "function"
  console.log(typeof Math.max, typeof Math.min);           // function function
  console.log(typeof [].push, typeof "x".toUpperCase);     // function function
  console.log(typeof parseInt, typeof String);             // function function

  // variadic Math statics as values
  const mx = Math.max, mn = Math.min;
  console.log(mx(3, 1, 4, 1, 5), mn(3, 1, 4, 1, 5));       // 5 1
  console.log([3, 7, 2, 8].reduce((a, b) => Math.max(a, b))); // 8

  // prototype METHOD value: unbound, but .bind / .call / .apply work
  const out: number[] = [];
  const boundPush = out.push.bind(out);
  boundPush(1); boundPush(2, 3);
  console.log(out.join(","));                              // 1,2,3
  const arr2: number[] = [];
  arr2.push.call(arr2, 9);
  arr2.push.apply(arr2, [8, 7]);
  console.log(arr2.join(","));                             // 9,8,7
  const up = "abc".toUpperCase;
  console.log(up.call("xyz"));                             // XYZ

  // Number static predicates as values
  const isInt = Number.isInteger;
  console.log([1, 1.5, 2, 2.5].filter(isInt).join(","));   // 1,2

  // Array.isArray as a value
  const isArr = Array.isArray;
  console.log(isArr([1]), isArr("x"));                     // true false

  // existing CALLS must be unchanged (regression)
  console.log(Math.sqrt(16), Math.max(1, 2, 3));           // 4 3
  const a = [1]; a.push(2, 3); console.log(a.join(","));   // 1,2,3
  console.log("hi".toUpperCase(), parseInt("42"));         // HI 42
}

main();
